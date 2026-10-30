/**
 * Steps that move a tier from an old member to a new one (decision 0011):
 * swap a healthy member live with mdadm --replace, take a failed or
 * replaced member out, and rebuild onto a new member of a degraded array.
 * Members are read from /proc/mdstat and md sysfs, because mdadm --detail
 * --export reports a failed member under its old slot number and a
 * replaced one as a spare.
 */

import { basename } from 'node:path';

import { type MdstatMember, parseMdstat } from '@ohr/shared/parsers/mdstat';

import { mdArrayPath } from '../executors/md-array.ts';
import {
  addMembers,
  mdadmAddArgs,
  mdadmRemoveArgs,
  mdadmReplaceArgs,
  removeMember,
  replaceMember,
} from '../executors/md-reshape.ts';
import { readSyncState } from '../executors/md-sync.ts';
import { formatCommand, type StepDefinition } from './engine.ts';
import { alreadyDone, blocked, READY } from './pool-steps.ts';
import type { MdDeps } from './reshape-steps.ts';

/** The array's members as mdstat shows them, or null when the array is not running. */
async function members(deps: MdDeps, path: string): Promise<readonly MdstatMember[] | null> {
  const name = await deps.kernelName(path);
  const array = parseMdstat((await deps.files('/proc/mdstat')) ?? '').find(
    (entry) => entry.name === name,
  );
  return array?.members ?? null;
}

function memberOf(list: readonly MdstatMember[], partition: string): MdstatMember | undefined {
  return list.find((member) => member.device === basename(partition));
}

/** True when md has been told to copy this member onto a replacement. */
async function wantsReplacement(deps: MdDeps, path: string, partition: string): Promise<boolean> {
  const name = await deps.kernelName(path);
  const state = await deps.files(`/sys/block/${name}/md/dev-${basename(partition)}/state`);
  return state?.includes('want_replacement') === true;
}

/** True when the new member holds its slot or is being copied into it. */
function taken(member: MdstatMember | undefined): boolean {
  return member !== undefined && !member.faulty && (!member.spare || member.replacement);
}

export interface Swap {
  readonly tier: number;
  readonly oldPartition: string;
  readonly newPartition: string;
}

/** Copies the old member onto the new one, which must already be a spare in the array. */
export function replaceStep(poolId: string, swap: Swap, deps: MdDeps): StepDefinition {
  const path = mdArrayPath(poolId, swap.tier);
  const request = { array: path, oldMember: swap.oldPartition, newMember: swap.newPartition };
  return {
    name: `replace ${swap.oldPartition} in tier ${swap.tier}`,
    description: `Copy ${swap.oldPartition} onto ${swap.newPartition} while ${path} keeps its redundancy`,
    commands: [formatCommand('mdadm', mdadmReplaceArgs(request))],
    async precondition() {
      const list = await members(deps, path);
      if (list === null) {
        return blocked(`${path} is not running`);
      }
      const added = memberOf(list, swap.newPartition);
      if (taken(added)) {
        return alreadyDone(`${swap.newPartition} already holds, or is taking, the slot`);
      }
      if (added === undefined) {
        return blocked(`${swap.newPartition} is not in ${path}`);
      }
      const old = memberOf(list, swap.oldPartition);
      if (old === undefined || old.faulty) {
        return blocked(`${swap.oldPartition} is not a working member of ${path}`);
      }
      if (await wantsReplacement(deps, path, swap.oldPartition)) {
        return alreadyDone(`md is already replacing ${swap.oldPartition}`);
      }
      const state = await readSyncState(deps.files, await deps.kernelName(path));
      if (state.kind === 'busy') {
        return blocked(`${path} is running a ${state.progress.operation}`);
      }
      return READY;
    },
    async action({ run }) {
      await replaceMember(run, request);
    },
    async postcondition() {
      const list = (await members(deps, path)) ?? [];
      if (
        !(
          taken(memberOf(list, swap.newPartition)) ||
          (await wantsReplacement(deps, path, swap.oldPartition))
        )
      ) {
        throw new Error(`md is not replacing ${swap.oldPartition} with ${swap.newPartition}`);
      }
    },
  };
}

/**
 * Takes a member out of the array once it no longer holds data: a failed
 * member, the old one after a live replace, or with `failed`, every failed
 * member, such as one whose drive is gone.
 */
export function removeStep(
  poolId: string,
  remove: { readonly tier: number; readonly member: string | 'failed' },
  deps: MdDeps,
): StepDefinition {
  const path = mdArrayPath(poolId, remove.tier);
  let label = remove.member;
  if (remove.member === 'failed') {
    label = 'failed members';
  }
  const leftover = (list: readonly MdstatMember[]): boolean => {
    if (remove.member === 'failed') {
      return list.some((member) => member.faulty);
    }
    return memberOf(list, remove.member) !== undefined;
  };
  return {
    name: `remove ${label} from tier ${remove.tier}`,
    description: `Take ${label} out of ${path}. Nothing on the drive is erased`,
    commands: [formatCommand('mdadm', mdadmRemoveArgs(path, remove.member))],
    async precondition() {
      const list = await members(deps, path);
      if (list === null) {
        return blocked(`${path} is not running`);
      }
      if (!leftover(list)) {
        return alreadyDone(`${path} has no ${label} to remove`);
      }
      if (remove.member !== 'failed') {
        const member = memberOf(list, remove.member);
        if (member !== undefined && !member.faulty && !member.spare) {
          return blocked(`${remove.member} still holds data in ${path}`);
        }
      }
      return READY;
    },
    async action({ run }) {
      await removeMember(run, { array: path, member: remove.member });
    },
    async postcondition() {
      if (leftover((await members(deps, path)) ?? [])) {
        throw new Error(`${path} still has ${label}`);
      }
    },
  };
}

/** Adds the new member to a degraded array, which starts rebuilding onto it. */
export function rebuildStep(
  poolId: string,
  rebuild: { readonly tier: number; readonly partition: string },
  deps: MdDeps,
): StepDefinition {
  const path = mdArrayPath(poolId, rebuild.tier);
  return {
    name: `rebuild tier ${rebuild.tier} onto ${rebuild.partition}`,
    description: `Add ${rebuild.partition} to ${path}, which rebuilds the missing member onto it`,
    commands: [formatCommand('mdadm', mdadmAddArgs(path, [rebuild.partition]))],
    async precondition() {
      const list = await members(deps, path);
      if (list === null) {
        return blocked(`${path} is not running`);
      }
      if (memberOf(list, rebuild.partition) !== undefined) {
        return alreadyDone(`${rebuild.partition} is already in ${path}`);
      }
      const state = await readSyncState(deps.files, await deps.kernelName(path));
      if (state.kind === 'busy') {
        return blocked(`${path} is running a ${state.progress.operation}`);
      }
      if (!state.degraded) {
        return blocked(`${path} is not missing a member, so there is nothing to rebuild`);
      }
      return READY;
    },
    async action({ run }) {
      await addMembers(run, { array: path, members: [rebuild.partition] });
    },
    async postcondition() {
      if (memberOf((await members(deps, path)) ?? [], rebuild.partition) === undefined) {
        throw new Error(`${rebuild.partition} is not in ${path}`);
      }
    },
  };
}
