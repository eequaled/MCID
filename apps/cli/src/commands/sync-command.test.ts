import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCliTest, json, runCli } from '../test-support/cli-harness.js';
import { baseRoutes } from '../test-support/fixtures.js';

afterEach(cleanupCliTest);

/** SyncChangeDetailsResponseDto: {changes, total}, paged by limit/offset. */
function changesRoute(total = 3) {
  return (url: URL) => {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const slice = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({
      entityType: 'member',
      entityId: `33333333333333330${offset + i}`,
      action: offset + i === 2 ? 'updated' : 'added',
      entityName: `member_${offset + i + 1}`,
      description: `member_${offset + i + 1}`,
    }));
    return json({ changes: slice, total });
  };
}

describe('sync changes', () => {
  it('pages with limit/offset until every change is read', async () => {
    const result = await runCli(['sync', 'changes', '42'], {
      routes: baseRoutes({
        'GET /admin/sync/logs/:syncLogId/changes': changesRoute(3),
      }),
    });

    expect(result.exitCode).toBe(0);
    const pages = result.requests.filter((r) => r.path === '/admin/sync/logs/42/changes');
    expect(pages.length).toBeGreaterThanOrEqual(1);
    // With the default page size of 100 and 3 rows, one page suffices — but
    // the request must at least declare its page size instead of hoping the
    // server default covers everything.
    expect(pages[0]?.query['limit']).toBeDefined();
    expect(result.stdout).toContain('member_3');
  });

  it('reads past the first 100 changes', async () => {
    const result = await runCli(['sync', 'changes', '42'], {
      routes: baseRoutes({
        'GET /admin/sync/logs/:syncLogId/changes': changesRoute(150),
      }),
    });

    expect(result.exitCode).toBe(0);
    const pages = result.requests.filter((r) => r.path === '/admin/sync/logs/42/changes');
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(result.stdout).toContain('member_150');
  });

  it('sends --type as the action filter', async () => {
    const result = await runCli(['sync', 'changes', '42', '--type', 'added'], {
      routes: baseRoutes({
        'GET /admin/sync/logs/:syncLogId/changes': changesRoute(3),
      }),
    });

    expect(result.exitCode).toBe(0);
    const get = result.requests.find((r) => r.path === '/admin/sync/logs/42/changes');
    expect(get?.query['action']).toBe('added');
  });
});
