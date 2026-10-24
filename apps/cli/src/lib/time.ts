import { CliError, ExitCode } from '../errors.js';

const DURATION_PATTERN = /^(\d{1,4})([mhd])$/;

const UNIT_MS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/**
 * Normalizes a `--since`/`--until` value for the API's ISO-only date fields:
 * duration shorthand (`30m`, `24h`, `7d`) becomes an ISO timestamp relative to
 * now, and ISO timestamps pass through. Anything else is a usage error before
 * a request is made, instead of the API's 400.
 */
export function parseSince(input: string, label = 'value'): string {
  const duration = DURATION_PATTERN.exec(input.trim());
  if (duration) {
    const [, amountRaw, unit] = duration;
    if (!unit || !(unit in UNIT_MS)) {
      throw new CliError(
        `invalid ${label} "${input}": use a duration (30m, 24h, 7d) or an ISO timestamp (2026-10-01T00:00:00Z)`,
        ExitCode.Usage,
      );
    }
    return new Date(
      Date.now() - Number(amountRaw) * UNIT_MS[unit as keyof typeof UNIT_MS],
    ).toISOString();
  }

  // A parsable timestamp passes through verbatim; only shorthand is expanded.
  if (!Number.isNaN(Date.parse(input))) {
    return input;
  }

  throw new CliError(
    `invalid ${label} "${input}": use a duration (30m, 24h, 7d) or an ISO timestamp (2026-10-01T00:00:00Z)`,
    ExitCode.Usage,
  );
}
