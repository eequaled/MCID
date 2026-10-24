import { describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import { parseSince } from './time.js';

describe('parseSince', () => {
  it('expands duration shorthand into ISO timestamps', () => {
    const before = Date.now() - 24 * 3600 * 1000;
    const iso = parseSince('24h');
    const parsed = new Date(iso);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(Math.abs(parsed.getTime() - before)).toBeLessThan(2000);
  });

  it('supports minutes, hours and days', () => {
    for (const shorthand of ['30m', '24h', '7d']) {
      expect(Number.isNaN(new Date(parseSince(shorthand)).getTime())).toBe(false);
    }
  });

  it('passes ISO timestamps through unchanged', () => {
    expect(parseSince('2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00Z');
  });

  it('rejects anything that is neither a duration nor a date', () => {
    expect(() => parseSince('yesterday')).toThrow(CliError);
    expect(() => parseSince('24x')).toThrow(CliError);
  });
});
