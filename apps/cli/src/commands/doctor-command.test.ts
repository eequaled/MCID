import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The crypto probe must not touch the OS keychain; everything else in
// crypto-store stays real.
vi.mock('../crypto-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto-store.js')>();
  return {
    ...actual,
    defaultKeyProvider: () => ({
      keyForWrite: async () => ({ source: 'file' as const, key: Buffer.alloc(32, 7) }),
      keyFor: async () => Buffer.alloc(32, 7),
    }),
  };
});

import { cleanupCliTest, json, runCli } from '../test-support/cli-harness.js';
import { baseRoutes } from '../test-support/fixtures.js';

afterEach(cleanupCliTest);

async function tempConfigEnv() {
  const tmp = await mkdtemp(join(tmpdir(), 'mcid-doctor-'));
  vi.stubEnv('MCID_CLI_CONFIG_PATH', join(tmp, 'config.json'));
  return tmp;
}

describe('doctor', () => {
  it(
    'checks reachability on an endpoint that does not need monitoring:read',
    { timeout: 20_000 },
    async () => {
      await tempConfigEnv();
      const result = await runCli(['doctor'], {
        routes: baseRoutes({
          // A plain admin without monitoring:read is forbidden here…
          'GET /admin/monitoring/health': () => json({ message: 'Forbidden resource' }, 403),
          // …but the liveness probe and identity check answer.
          'GET /': () => json({ name: 'mcid', status: 'ok' }),
          'GET /auth/admin/me': () =>
            json({ id: '333333333333333333', username: 'john_doe', isAdmin: true }),
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('API reachability');
      expect(result.stdout).not.toContain('403');
    },
  );

  it('exits non-zero when a check fails', { timeout: 20_000 }, async () => {
    await tempConfigEnv();
    const result = await runCli(['doctor'], {
      routes: baseRoutes({
        'GET /': () => json({ message: 'not found' }, 404),
        'GET /auth/admin/me': () => json({ message: 'nope' }, 401),
      }),
    });

    expect(result.exitCode).not.toBe(0);
  });
});
