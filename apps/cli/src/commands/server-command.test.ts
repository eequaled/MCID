import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupCliTest,
  json,
  runCli,
  type RouteHandler,
} from '../test-support/cli-harness.js';
import {
  baseRoutes,
  CATEGORY_ID,
  channelList,
  CHANNEL_ID,
  MAIN_SERVER_ID,
  mainServer,
  messagePage,
} from '../test-support/fixtures.js';

afterEach(cleanupCliTest);

describe('server channels', () => {
  it('renders the wrapped {channels, categories} shape and derives the category name', async () => {
    const result = await runCli(['server', 'channels'], {
      routes: baseRoutes({
        'GET /admin/servers/:serverId/channels': () => json(channelList),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('general');
    // parentId mapped to the category name, not a missing categoryName field
    expect(result.stdout).toContain('Text Channels');
  });

  it('prints channels from the wrapped shape with --json', async () => {
    const result = await runCli(['server', 'channels', '--json'], {
      routes: baseRoutes({
        'GET /admin/servers/:serverId/channels': () => json(channelList),
      }),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { channels?: unknown[] };
    expect(parsed.channels).toHaveLength(2);
  });
});

describe('server channel --messages', () => {
  const routes = baseRoutes({
    [`GET /admin/servers/:serverId/channels/${CHANNEL_ID}`]: () =>
      json(channelList.channels[0]),
    [`GET /admin/servers/:serverId/channels/${CHANNEL_ID}/messages`]: () =>
      json(messagePage),
  });

  it('renders messages from the {messages, hasMore} wrapper using timestamp', async () => {
    const result = await runCli(
      ['server', 'channel', 'Micro Club', CHANNEL_ID, '--messages', '10'],
      { routes },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Hello from the test');
    expect(result.stdout).toContain('john_doe');
  });

  it('rejects --messages above the API maximum of 100 with a usage error', async () => {
    const result = await runCli(
      ['server', 'channel', 'Micro Club', CHANNEL_ID, '--messages', '200'],
      { routes },
    );

    expect(result.exitCode).toBe(64);
    expect(result.requests).toHaveLength(0);
  });
});

describe('server add', () => {
  it('omits name from the body when --name is not given', async () => {
    const result = await runCli(['server', 'add', '777777777777777777'], {
      routes: baseRoutes({
        'POST /servers': () => json({ ...mainServer, id: '777777777777777777' }, 201),
      }),
    });

    expect(result.exitCode).toBe(0);
    const post = result.requests.find((r) => r.method === 'POST' && r.path === '/servers');
    expect(post).toBeDefined();
    expect(post?.body).toEqual({ guildId: '777777777777777777' });
  });

  it('sends name only when --name is passed', async () => {
    const result = await runCli(
      ['server', 'add', '777777777777777777', '--name', 'Launchpad'],
      {
        routes: baseRoutes({
          'POST /servers': () => json({ ...mainServer, id: '777777777777777777' }, 201),
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    const post = result.requests.find((r) => r.method === 'POST' && r.path === '/servers');
    expect(post?.body).toEqual({ guildId: '777777777777777777', name: 'Launchpad' });
  });

  it('refuses to re-register an existing guild id and points at server update', async () => {
    const result = await runCli(['server', 'add', MAIN_SERVER_ID], {
      routes: baseRoutes({
        'POST /servers': () => json(mainServer, 201),
      }),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('server update');
    // The dangerous upsert POST must never be sent.
    expect(result.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('server list / get sync fields', () => {
  it('reads lastSyncAt (the field the API returns) for the LAST SYNC column', async () => {
    const result = await runCli(['server', 'list'], {
      routes: baseRoutes({
        'GET /servers': () => json([mainServer]),
      }),
    });

    expect(result.exitCode).toBe(0);
    // lastSyncAt is 2026-10-23; if the CLI read lastSyncedAt it would print "never".
    expect(result.stdout).not.toContain('never');
  });

  it('derives auto sync from syncFrequencyHours instead of a missing autoSyncEnabled', async () => {
    const result = await runCli(['server', 'get'], {
      routes: baseRoutes({
        'GET /servers': () => json([mainServer]),
        [`GET /servers/${MAIN_SERVER_ID}`]: () =>
          json({ ...mainServer, lastSyncAt: '2026-10-23T10:00:00.000Z' }),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('every 1h');
    expect(result.stdout).not.toContain('Auto Sync: disabled');
    expect(result.stdout).not.toContain('never');
  });
});
