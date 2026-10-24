import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./prompts.js', () => ({
  promptInput: vi.fn(async () => 'the wrong text'),
  promptConfirm: vi.fn(async () => false),
}));

import { CliError, ExitCode } from '../errors.js';
import { confirmDestructive } from './confirm.js';
import { cleanupCliTest } from '../test-support/cli-harness.js';

afterEach(cleanupCliTest);

describe('confirmDestructive abort', () => {
  it('exits non-zero when the confirmation text does not match', async () => {
    // A cancelled destructive action must not look like success to scripts.
    const originalTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    let thrown: unknown;
    try {
      await confirmDestructive({
        resourceType: 'server',
        resourceName: 'Competition Server',
      });
    } catch (err) {
      thrown = err;
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalTty,
        configurable: true,
      });
    }

    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).not.toBe(ExitCode.Ok);
  });
});
