import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCliTest, json, runCli } from '../test-support/cli-harness.js';
import { baseRoutes, MAIN_SERVER_ID, mainServer, PROJECT_ID } from '../test-support/fixtures.js';

afterEach(cleanupCliTest);

describe('settings reset', () => {
  // The API's POST /admin/settings/reset takes no body: it clears every
  // override. The CLI must not pretend per-key reset exists.
  it('rejects per-key arguments with a usage error instead of wiping everything', async () => {
    const result = await runCli(
      ['settings', 'reset', 'cache.statsTtlMs', '--yes'],
      { routes: baseRoutes() },
    );

    expect(result.exitCode).toBe(64);
    expect(result.requests.some((r) => r.path === '/admin/settings/reset')).toBe(false);
  });

  it('resets all settings with no body and says so', async () => {
    const result = await runCli(['settings', 'reset', '--yes'], {
      routes: baseRoutes({
        'POST /admin/settings/reset': () => json({ cache: {}, rateLimit: {}, preferences: {} }),
      }),
    });

    expect(result.exitCode).toBe(0);
    const post = result.requests.find((r) => r.path === '/admin/settings/reset');
    expect(post?.body).toBeUndefined();
    expect(result.stdout).toContain('all settings');
  });
});

describe('audit list filters', () => {
  it('converts --since durations to an ISO dateFrom the API accepts', async () => {
    const result = await runCli(['audit', 'list', '--since', '24h'], {
      routes: baseRoutes({
        'GET /admin/audit/logs': (url) => json({ logs: [] }),
      }),
    });

    expect(result.exitCode).toBe(0);
    const get = result.requests.find((r) => r.path === '/admin/audit/logs');
    expect(get).toBeDefined();
    const dateFrom = get?.query['dateFrom'];
    expect(typeof dateFrom).toBe('string');
    // ISO timestamp, not the raw "24h" the API would 400 on
    expect(Number.isNaN(Date.parse(String(dateFrom)))).toBe(false);
    expect(dateFrom).not.toBe('24h');
  });

  it('validates --action against the action categories and forwards it as actionType', async () => {
    const result = await runCli(['audit', 'list', '--action', 'permission'], {
      routes: baseRoutes({
        'GET /admin/audit/logs': () => json({ logs: [] }),
      }),
    });

    expect(result.exitCode).toBe(0);
    const get = result.requests.find((r) => r.path === '/admin/audit/logs');
    expect(get?.query['actionType']).toBe('permission');
  });

  it('rejects an --action that is not an action category', async () => {
    const result = await runCli(['audit', 'list', '--action', 'role_grants_updated'], {
      routes: baseRoutes(),
    });

    expect(result.exitCode).toBe(64);
    expect(result.requests.some((r) => r.path === '/admin/audit/logs')).toBe(false);
  });
});

describe('monitor auth-failures --since', () => {
  it('converts durations to ISO before sending dateFrom', async () => {
    const result = await runCli(['monitor', 'auth-failures', '--since', '7d'], {
      routes: baseRoutes({
        'GET /admin/monitoring/auth-failures': () => json({ failures: [] }),
      }),
    });

    expect(result.exitCode).toBe(0);
    const get = result.requests.find((r) => r.path === '/admin/monitoring/auth-failures');
    const dateFrom = String(get?.query['dateFrom']);
    expect(dateFrom).not.toBe('7d');
    expect(Number.isNaN(Date.parse(dateFrom))).toBe(false);
  });
});

describe('discord-webhook list', () => {
  // WebhookListResponseDto: {webhooks, total, limit, offset}
  const listPage = (offset: number) => ({
    webhooks: [
      {
        id: `wh-${offset}-1`,
        name: 'Deploy hook',
        channelId: '444444444444444444',
        channelName: 'general',
        serverId: MAIN_SERVER_ID,
        serverName: 'Micro Club',
        createdAt: '2026-10-01T00:00:00.000Z',
        usageCount: 3,
        lastUsedAt: null,
      },
    ],
    total: 2,
    limit: 1,
    offset,
  });

  it('unwraps {webhooks, total, limit, offset} and renders rows', async () => {
    const result = await runCli(['discord-webhook', 'list', '--project', 'Portal'], {
      routes: baseRoutes({
        [`GET /admin/projects/${PROJECT_ID}/webhooks`]: (url) =>
          json(listPage(Number(url.searchParams.get('offset') ?? 0))),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deploy hook');
  });

  it('pages with limit/offset until total rows are collected', async () => {
    const result = await runCli(['discord-webhook', 'list', '--project', 'Portal'], {
      routes: baseRoutes({
        [`GET /admin/projects/${PROJECT_ID}/webhooks`]: (url) =>
          json(listPage(Number(url.searchParams.get('offset') ?? 0))),
      }),
    });

    expect(result.exitCode).toBe(0);
    const pages = result.requests.filter(
      (r) => r.path === `/admin/projects/${PROJECT_ID}/webhooks`,
    );
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(result.stdout).toContain('wh-1-1');
  });
});

describe('status', () => {
  const healthNoRedis = {
    api: { status: 'healthy', uptime: 100, responseTime: 5 },
    database: { status: 'connected', queryTime: 2 },
    // Optional component: present with status disconnected on Redis-less deployments.
    redis: { status: 'disconnected' },
    discord: { status: 'connected', guilds: 1, latency: 20 },
  };

  it('treats a disconnected optional Redis as a warning, not a failure', async () => {
    const result = await runCli(['status'], {
      routes: baseRoutes({
        'GET /admin/monitoring/health': () => json(healthNoRedis),
        'GET /admin/sync/status/all': () => json([]),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Database');
  });

  it('still fails when a core component (database) is down', async () => {
    const result = await runCli(['status'], {
      routes: baseRoutes({
        'GET /admin/monitoring/health': () => json({
          ...healthNoRedis,
          database: { status: 'disconnected', queryTime: 0 },
        }),
        'GET /admin/sync/status/all': () => json([]),
      }),
    });

    expect(result.exitCode).toBe(5);
  });

  it('reads lastSyncAt and resolves server names for sync rows', async () => {
    const result = await runCli(['status'], {
      routes: baseRoutes({
        'GET /admin/monitoring/health': () => json(healthNoRedis),
        'GET /admin/sync/status/all': () =>
          json([
            {
              serverId: MAIN_SERVER_ID,
              status: 'success',
              lastSyncAt: '2026-10-23T10:00:00.000Z',
              membersSynced: 10,
              rolesSynced: 3,
            },
          ]),
        'GET /servers': () => json([mainServer]),
      }),
    });

    expect(result.exitCode).toBe(0);
    // Server name resolved from GET /servers, real lastSyncAt (not "never").
    expect(result.stdout).toContain('Micro Club');
    expect(result.stdout).not.toContain('never');
  });
});
