import { stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCliTest, json, runCli } from '../test-support/cli-harness.js';
import { baseRoutes, MAIN_SERVER_ID, PROJECT_ID, projectRecord } from '../test-support/fixtures.js';

afterEach(cleanupCliTest);

describe('project access grant', () => {
  const existingGrants = [
    {
      serverId: MAIN_SERVER_ID,
      scopes: ['read_members'],
      operations: { READ: true, SEND_MESSAGES: true, MANAGE_WEBHOOKS: false },
    },
  ];

  const routes = (putBody: (body: unknown) => void) =>
    baseRoutes({
      [`GET /admin/projects/${PROJECT_ID}/servers`]: () => json(existingGrants),
      [`PUT /admin/projects/${PROJECT_ID}/servers/${MAIN_SERVER_ID}`]: (_url, init) => {
        putBody(JSON.parse(String(init.body)));
        return json(existingGrants[0]!);
      },
    });

  it('preserves existing operations when --operation is omitted', async () => {
    let sent: unknown;
    const result = await runCli(
      ['project', 'access', 'grant', 'Portal', 'Micro Club', '--scope', 'read_members'],
      { routes: routes((body) => (sent = body)) },
    );

    expect(result.exitCode).toBe(0);
    expect(sent).toEqual({
      scopes: ['read_members'],
      operations: { READ: true, SEND_MESSAGES: true, MANAGE_WEBHOOKS: false },
    });
  });

  it('sends all three operation booleans when --operation is given', async () => {
    let sent: unknown;
    const result = await runCli(
      [
        'project',
        'access',
        'grant',
        'Portal',
        'Micro Club',
        '--scope',
        'read_members',
        '--operation',
        'READ',
      ],
      { routes: routes((body) => (sent = body)) },
    );

    expect(result.exitCode).toBe(0);
    expect(sent).toEqual({
      scopes: ['read_members'],
      operations: { READ: true, SEND_MESSAGES: false, MANAGE_WEBHOOKS: false },
    });
  });

  it('rejects an unknown scope before any request', async () => {
    const result = await runCli(
      ['project', 'access', 'grant', 'Portal', 'Micro Club', '--scope', 'read_everything'],
      { routes: baseRoutes() },
    );

    expect(result.exitCode).toBe(64);
    expect(result.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('rejects an unknown operation before any request', async () => {
    const result = await runCli(
      [
        'project',
        'access',
        'grant',
        'Portal',
        'Micro Club',
        '--scope',
        'read_members',
        '--operation',
        'DELETE_EVERYTHING',
      ],
      { routes: baseRoutes() },
    );

    expect(result.exitCode).toBe(64);
    expect(result.requests.some((r) => r.method === 'PUT')).toBe(false);
  });
});

describe('project create', () => {
  it('always includes the full API key in --json output (it is shown once, never again)', async () => {
    const result = await runCli(['project', 'create', '--name', 'Portal', '--json'], {
      routes: baseRoutes({
        'POST /admin/projects': () =>
          json({ apiKey: 'mcid_live_onceonlykey123', project: projectRecord }, 201),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('mcid_live_onceonlykey123');
    expect(result.stdout).not.toContain('[REDACTED]');
  });

  it('writes the --env-file with mode 0600', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mcid-create-'));
    const target = join(tmp, '.env');

    const result = await runCli(['project', 'create', '--name', 'Portal', '--env-file', target], {
      routes: baseRoutes({
        'POST /admin/projects': () =>
          json({ apiKey: 'mcid_live_onceonlykey123', project: projectRecord }, 201),
      }),
    });

    expect(result.exitCode).toBe(0);
    const mode = (await stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('refuses to overwrite an env file that already holds a key without --force', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mcid-create-'));
    const target = join(tmp, '.env');

    const result = await runCli(['project', 'create', '--name', 'Portal', '--env-file', target], {
      routes: baseRoutes({
        'POST /admin/projects': () =>
          json({ apiKey: 'mcid_live_secondkey456', project: projectRecord }, 201),
      }),
    });

    // Second create into the same file: the guard must reject before overwrite.
    const second = await runCli(['project', 'create', '--name', 'Portal', '--env-file', target], {
      routes: baseRoutes({
        'POST /admin/projects': () =>
          json({ apiKey: 'mcid_live_secondkey456', project: projectRecord }, 201),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain('--force');
  });
});
