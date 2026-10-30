/**
 * The API over ohr-core (decision 0008): system, drives, pools, volumes, and
 * jobs. Every route checks its body with the shared schema, asks core, and
 * passes core's answer on. Core's errors become HTTP answers with the same
 * code, so the UI can show a refusal's reasons as core wrote them.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { CallableMethod } from '@ohr/rpc/client';
import { ConnectionClosedError } from '@ohr/rpc/connection-closed-error';
import type { Params, Result, RpcErrorCode } from '@ohr/rpc/contract';
import { CoreUnavailableError } from '@ohr/rpc/core-unavailable-error';
import { RpcError } from '@ohr/rpc/rpc-error';
import { poolCreateRequestSchema } from '@ohr/shared/pool-create-request';
import {
  driveReplacePreviewRequestSchema,
  driveReplaceSubmissionSchema,
  poolExpandPreviewRequestSchema,
  poolExpandSubmissionSchema,
  poolSubmissionSchema,
  volumeGrowPreviewRequestSchema,
  volumeGrowSubmissionSchema,
  volumePreviewRequestSchema,
  volumeSubmissionSchema,
} from '@ohr/shared/web-api';

import { ApiProblem, HTTP } from './api-problem.ts';
import type { CoreLink } from './core-link.ts';

/** Which HTTP status each core error code becomes. */
const STATUS_BY_CODE: Record<RpcErrorCode, number> = {
  'invalid-request': HTTP.internalError,
  'invalid-params': HTTP.badRequest,
  'not-found': HTTP.notFound,
  conflict: HTTP.conflict,
  'state-changed': HTTP.conflict,
  rejected: HTTP.unprocessable,
  internal: HTTP.internalError,
};

const idParams = z.strictObject({ id: z.string().min(1) });
const nameParams = z.strictObject({ name: z.string().min(1) });
const volumeParams = z.strictObject({ id: z.string().min(1), name: z.string().min(1) });
const jobIdParams = z.strictObject({ id: z.uuid() });
const systemQuery = z.strictObject({ smart: z.enum(['true', 'false']).optional() });

/** Refuses a submission whose input is for another pool than the path names. */
function samePool(inputPoolId: string, pathPoolId: string, what: string): void {
  if (inputPoolId !== pathPoolId) {
    throw new ApiProblem(
      HTTP.badRequest,
      'invalid-request',
      `The ${what} is for pool ${inputPoolId}, not ${pathPoolId}.`,
    );
  }
}

function coreProblem(error: unknown): unknown {
  if (error instanceof RpcError) {
    return new ApiProblem(STATUS_BY_CODE[error.code], error.code, error.message, error.reasons);
  }
  if (error instanceof CoreUnavailableError || error instanceof ConnectionClosedError) {
    return new ApiProblem(HTTP.serviceUnavailable, 'core-unavailable', error.message);
  }
  return error;
}

type Ask = <M extends CallableMethod>(method: M, params: Params<M>) => Promise<Result<M>>;

function registerReadRoutes(app: FastifyInstance, ask: Ask): void {
  app.get('/api/v1/system', (request) => {
    const { smart } = systemQuery.parse(request.query);
    if (smart === 'true') {
      return ask('system.state', { smart: true });
    }
    return ask('system.state', {});
  });

  app.get('/api/v1/drives', () => ask('drives.list', {}));

  app.get('/api/v1/drives/:name', async (request) => {
    const { name } = nameParams.parse(request.params);
    const { drives } = await ask('drives.list', {});
    const drive = drives.find((candidate) => candidate.name === name);
    if (drive === undefined) {
      throw new ApiProblem(HTTP.notFound, 'not-found', `There is no drive ${name}.`);
    }
    return { drive };
  });

  app.get('/api/v1/pools', () => ask('pools.list', {}));

  app.get('/api/v1/pools/:id', (request) => ask('pools.get', idParams.parse(request.params)));

  app.get('/api/v1/pools/:id/volumes', async (request) => {
    const { pool } = await ask('pools.get', idParams.parse(request.params));
    return { volumes: pool.volumes };
  });

  app.get('/api/v1/jobs', () => ask('jobs.list', {}));

  app.get('/api/v1/jobs/:id', (request) => ask('jobs.get', jobIdParams.parse(request.params)));
}

function registerCreateRoutes(app: FastifyInstance, ask: Ask): void {
  app.post('/api/v1/pools/preview', (request) =>
    ask('pools.previewCreate', poolCreateRequestSchema.parse(request.body)),
  );

  app.post('/api/v1/pools', async (request, reply) => {
    const { input, stateHash } = poolSubmissionSchema.parse(request.body);
    const result = await ask('jobs.submit', { kind: 'pool-create', input, stateHash });
    return reply.code(HTTP.accepted).send(result);
  });

  app.post('/api/v1/pools/:id/volumes/preview', (request) => {
    const { id } = idParams.parse(request.params);
    const body = volumePreviewRequestSchema.parse(request.body);
    return ask('volumes.previewCreate', { ...body, poolId: id });
  });

  app.post('/api/v1/pools/:id/volumes', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { input, stateHash } = volumeSubmissionSchema.parse(request.body);
    samePool(input.poolId, id, 'volume');
    const result = await ask('jobs.submit', { kind: 'volume-create', input, stateHash });
    return reply.code(HTTP.accepted).send(result);
  });

  app.post('/api/v1/jobs/:id/retry', async (request, reply) => {
    const result = await ask('jobs.retry', jobIdParams.parse(request.params));
    return reply.code(HTTP.accepted).send(result);
  });
}

/** Growing a pool, replacing a drive, and growing a volume (decision 0011, "Interfaces"). */
function registerExpansionRoutes(app: FastifyInstance, ask: Ask): void {
  app.post('/api/v1/pools/:id/expand/preview', (request) => {
    const { id } = idParams.parse(request.params);
    const body = poolExpandPreviewRequestSchema.parse(request.body);
    return ask('pools.previewExpand', { ...body, poolId: id });
  });

  app.post('/api/v1/pools/:id/expand', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { input, stateHash } = poolExpandSubmissionSchema.parse(request.body);
    samePool(input.poolId, id, 'expansion');
    const result = await ask('jobs.submit', { kind: 'pool-expand', input, stateHash });
    return reply.code(HTTP.accepted).send(result);
  });

  app.post('/api/v1/pools/:id/replace/preview', (request) => {
    const { id } = idParams.parse(request.params);
    const body = driveReplacePreviewRequestSchema.parse(request.body);
    return ask('drives.previewReplace', { ...body, poolId: id });
  });

  app.post('/api/v1/pools/:id/replace', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { input, stateHash } = driveReplaceSubmissionSchema.parse(request.body);
    samePool(input.poolId, id, 'replacement');
    const result = await ask('jobs.submit', { kind: 'drive-replace', input, stateHash });
    return reply.code(HTTP.accepted).send(result);
  });

  app.post('/api/v1/pools/:id/volumes/:name/grow/preview', (request) => {
    const { id, name } = volumeParams.parse(request.params);
    const body = volumeGrowPreviewRequestSchema.parse(request.body);
    return ask('volumes.previewGrow', { ...body, poolId: id, name });
  });

  app.post('/api/v1/pools/:id/volumes/:name/grow', async (request, reply) => {
    const { id, name } = volumeParams.parse(request.params);
    const { input, stateHash } = volumeGrowSubmissionSchema.parse(request.body);
    samePool(input.poolId, id, 'volume');
    if (input.name !== name) {
      throw new ApiProblem(
        HTTP.badRequest,
        'invalid-request',
        `The input grows volume ${input.name}, not ${name}.`,
      );
    }
    const result = await ask('jobs.submit', { kind: 'volume-grow', input, stateHash });
    return reply.code(HTTP.accepted).send(result);
  });
}

/** Registers the routes. Every one of them is private. */
export function registerApiRoutes(app: FastifyInstance, core: CoreLink): void {
  /** Calls core and turns its errors into ApiProblems. */
  const ask: Ask = (method, params) =>
    core.call(method, params).catch((error: unknown) => {
      throw coreProblem(error);
    });
  registerReadRoutes(app, ask);
  registerCreateRoutes(app, ask);
  registerExpansionRoutes(app, ask);
}
