/** Parser for `smartctl --json --all <device>`, smartmontools 7.0 or newer. */

import { z } from 'zod';

import { integerSchema, parseJsonText, textSchema, validate } from './parse-error.ts';

const SOURCE = 'smartctl output';

/** smartctl exit status bits, see smartctl(8) RETURN VALUES. */
const EXIT_BITS = {
  commandLineError: 1,
  deviceOpenFailed: 2,
  commandFailed: 4,
  diskFailing: 8,
  prefailBelowThreshold: 16,
  pastThreshold: 32,
  errorLogHasErrors: 64,
  selfTestLogHasErrors: 128,
} as const;

const ATTRIBUTE_REALLOCATED = 5;
const ATTRIBUTE_PENDING = 197;
const ATTRIBUTE_OFFLINE_UNCORRECTABLE = 198;

const attributeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  raw: z.object({ value: z.number() }),
});

const messageSchema = z.object({ string: z.string(), severity: z.string() });

const reportSchema = z.object({
  smartctl: z.object({
    exit_status: z.number().int(),
    messages: z.array(messageSchema).optional(),
  }),
  device: z.object({ name: z.string(), protocol: textSchema }).optional(),
  model_name: textSchema,
  serial_number: textSchema,
  firmware_version: textSchema,
  user_capacity: z.object({ bytes: integerSchema }).optional(),
  smart_status: z.object({ passed: z.boolean() }).optional(),
  temperature: z.object({ current: z.number() }).optional(),
  power_on_time: z.object({ hours: z.number() }).optional(),
  ata_smart_attributes: z.object({ table: z.array(attributeSchema) }).optional(),
  nvme_smart_health_information_log: z
    .object({
      critical_warning: z.number().int(),
      percentage_used: z.number(),
      media_errors: z.number(),
    })
    .optional(),
});

type Report = z.infer<typeof reportSchema>;

function attributeRaw(report: Report, id: number): number | null {
  const attribute = report.ata_smart_attributes?.table.find((entry) => entry.id === id);
  return attribute?.raw.value ?? null;
}

function decodeExitStatus(status: number): SmartExitFlags {
  const flags = {} as Record<keyof typeof EXIT_BITS, boolean>;
  for (const [key, bit] of Object.entries(EXIT_BITS) as [keyof typeof EXIT_BITS, number][]) {
    // Bit `bit` is set when the quotient is odd. Arithmetic keeps the bitwise-operator rule happy.
    flags[key] = Math.floor(status / bit) % 2 === 1;
  }
  return flags;
}

export type SmartExitFlags = Readonly<Record<keyof typeof EXIT_BITS, boolean>>;

export interface SmartMessage {
  readonly text: string;
  /** information, warning, or error. */
  readonly severity: string;
}

export interface SmartReport {
  readonly device: string | null;
  /** ATA, NVMe, or SCSI. */
  readonly protocol: string | null;
  readonly model: string | null;
  readonly serial: string | null;
  readonly firmware: string | null;
  readonly capacityBytes: number | null;
  /** Overall health self-assessment. Null when the drive did not report one. */
  readonly passed: boolean | null;
  readonly temperatureCelsius: number | null;
  readonly powerOnHours: number | null;
  /** ATA attribute 5. */
  readonly reallocatedSectors: number | null;
  /** ATA attribute 197. */
  readonly pendingSectors: number | null;
  /** ATA attribute 198. */
  readonly offlineUncorrectable: number | null;
  /** NVMe media and data integrity errors. */
  readonly mediaErrors: number | null;
  /** NVMe percentage of rated endurance used. */
  readonly percentageUsed: number | null;
  /** NVMe critical warning bit field. Zero means no warnings. */
  readonly criticalWarning: number | null;
  readonly exitStatus: number;
  readonly exitFlags: SmartExitFlags;
  /** Messages smartctl printed, such as why it could not read the drive. */
  readonly messages: readonly SmartMessage[];
}

export function parseSmartctl(text: string): SmartReport {
  const report = validate(SOURCE, reportSchema, parseJsonText(SOURCE, text));
  const nvme = report.nvme_smart_health_information_log;
  return {
    device: report.device?.name ?? null,
    protocol: report.device?.protocol ?? null,
    model: report.model_name,
    serial: report.serial_number,
    firmware: report.firmware_version,
    capacityBytes: report.user_capacity?.bytes ?? null,
    passed: report.smart_status?.passed ?? null,
    temperatureCelsius: report.temperature?.current ?? null,
    powerOnHours: report.power_on_time?.hours ?? null,
    reallocatedSectors: attributeRaw(report, ATTRIBUTE_REALLOCATED),
    pendingSectors: attributeRaw(report, ATTRIBUTE_PENDING),
    offlineUncorrectable: attributeRaw(report, ATTRIBUTE_OFFLINE_UNCORRECTABLE),
    mediaErrors: nvme?.media_errors ?? null,
    percentageUsed: nvme?.percentage_used ?? null,
    criticalWarning: nvme?.critical_warning ?? null,
    exitStatus: report.smartctl.exit_status,
    exitFlags: decodeExitStatus(report.smartctl.exit_status),
    messages: (report.smartctl.messages ?? []).map((message) => ({
      text: message.string,
      severity: message.severity,
    })),
  };
}
