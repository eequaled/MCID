import { stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCliTest, json, runCli } from '../test-support/cli-harness.js';
import { baseRoutes } from '../test-support/fixtures.js';

afterEach(cleanupCliTest);

describe('dev token refresh', () => {
  const refreshResponse = {
    token: 'new-access-token-abcdefghijklmnop',
    expiresAt: '2026-11-24T00:00:00.000Z',
    refreshToken: 'new-refresh-token-qrstuvwxyz1234',
    member: { id: '333333333333333333', username: 'john_doe' },
    roles: [],
  };

  const routes = baseRoutes({
    'POST /auth/token/refresh': () => json(refreshResponse),
  });

  it('prints the new token pair unmasked (the old pair is already dead)', async () => {
    const result = await runCli(
      ['dev', 'token', 'refresh', 'old-refresh-token', '--token', 'old-access'],
      { routes },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('new-access-token-abcdefghijklmnop');
    expect(result.stdout).toContain('new-refresh-token-qrstuvwxyz1234');
    expect(result.stdout).not.toContain('[REDACTED]');
  });

  it('runs as the nested two-token form: dev token refresh', async () => {
    const result = await runCli(
      ['dev', 'token', 'refresh', 'old-refresh-token', '--token', 'old-access'],
      { routes },
    );

    expect(result.requests.some((r) => r.path === '/auth/token/refresh')).toBe(true);
  });
});

describe('dev token validate (nested grammar)', () => {
  it('runs as the nested two-token form: dev token validate', async () => {
    const result = await runCli(
      ['dev', 'token', 'validate', 'some-session-token', '--api-key', 'mcid_live_key'],
      {
        routes: baseRoutes({
          'POST /auth/validate': () => json({ valid: true, member: { username: 'john_doe' } }),
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('valid');
    expect(result.requests.some((r) => r.path === '/auth/validate')).toBe(true);
  });
});

describe('dev env --file', () => {
  it('writes the .env file with mode 0600', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mcid-env-'));
    const target = join(tmp, '.env');

    const result = await runCli(
      ['dev', 'env', '--file', target, '--api-key', 'mcid_live_supersecret'],
      { routes: baseRoutes() },
    );

    expect(result.exitCode).toBe(0);
    const mode = (await stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(result.requests).toHaveLength(0);
  });
});
