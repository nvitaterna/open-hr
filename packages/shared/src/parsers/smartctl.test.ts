import { describe, expect, it } from 'vitest';

import { readFixture } from './fixtures-test-helpers.ts';
import { ParseError } from './parse-error.ts';
import { parseSmartctl } from './smartctl.ts';

describe('parseSmartctl: SATA drives', () => {
  it('reads a healthy SATA drive', () => {
    expect(parseSmartctl(readFixture('example-shr1/smartctl-sda.json'))).toMatchObject({
      device: '/dev/sda',
      protocol: 'ATA',
      model: 'WDC WD40EFZX-68AWUN0',
      capacityBytes: 4_000_787_030_016,
      passed: true,
      temperatureCelsius: 34,
      powerOnHours: 18_342,
      reallocatedSectors: 0,
      pendingSectors: 0,
      offlineUncorrectable: 0,
      mediaErrors: null,
      exitStatus: 0,
      messages: [],
    });
  });

  it('reads a failing drive and decodes the exit status', () => {
    const report = parseSmartctl(readFixture('example-shr1/smartctl-sdb-failing.json'));
    expect(report).toMatchObject({
      passed: false,
      reallocatedSectors: 312,
      pendingSectors: 24,
      offlineUncorrectable: 8,
      exitStatus: 200,
    });
    expect(report.exitFlags).toEqual({
      commandLineError: false,
      deviceOpenFailed: false,
      commandFailed: false,
      diskFailing: true,
      prefailBelowThreshold: false,
      pastThreshold: false,
      errorLogHasErrors: true,
      selfTestLogHasErrors: true,
    });
  });
});

describe('parseSmartctl: other drives and errors', () => {
  it('reads an NVMe drive', () => {
    expect(parseSmartctl(readFixture('example-shr1/smartctl-nvme0n1.json'))).toMatchObject({
      protocol: 'NVMe',
      percentageUsed: 3,
      mediaErrors: 0,
      criticalWarning: 0,
      reallocatedSectors: null,
    });
  });

  it('reads the real report smartctl gives for a disk it cannot identify', () => {
    const report = parseSmartctl(readFixture('virtio-vm/smartctl-vda-unsupported.json'));
    expect(report).toMatchObject({ device: null, model: null, passed: null, exitStatus: 1 });
    expect(report.exitFlags.commandLineError).toBe(true);
    expect(report.messages).toEqual([
      { text: '/dev/vda: Unable to detect device type', severity: 'error' },
    ]);
  });

  it('rejects output without the smartctl section', () => {
    expect(() => parseSmartctl('{"device":{}}')).toThrow(ParseError);
  });
});
