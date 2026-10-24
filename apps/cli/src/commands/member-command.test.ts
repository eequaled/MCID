import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCliTest, json, runCli } from '../test-support/cli-harness.js';
import { baseRoutes, MAIN_SERVER_ID, MEMBER_ID } from '../test-support/fixtures.js';

afterEach(cleanupCliTest);

function memberRow(n: number) {
  return {
    memberId: `${MEMBER_ID.slice(0, 17)}${n}`,
    username: `member_${n}`,
    globalName: `Member ${n}`,
    avatar: null,
    isClubMember: true,
    serverCount: 1,
    servers: [
      {
        serverId: MAIN_SERVER_ID,
        serverName: 'Micro Club',
        isMainServer: true,
        joinedAt: '2026-09-01T00:00:00.000Z',
        roleNames: ['Member'],
      },
    ],
  };
}

/** PaginatedCrossServerListDto pages, switchable on page/limit. */
function memberPagesRoute(total = 3) {
  return (url: URL) => {
    const page = Number(url.searchParams.get('page') ?? 1);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const start = (page - 1) * limit;
    const data = Array.from({ length: Math.min(limit, total - start) }, (_, i) =>
      memberRow(start + i + 1),
    );
    return json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  };
}

describe('member list pagination', () => {
  it('sends page and limit so the API default of 20 rows is not a silent cap', async () => {
    const result = await runCli(['member', 'list'], {
      routes: baseRoutes({ 'GET /admin/members': memberPagesRoute(3) }),
    });

    expect(result.exitCode).toBe(0);
    const get = result.requests.find((r) => r.path === '/admin/members');
    expect(get).toBeDefined();
    expect(Number(get?.query['limit'])).toBe(100);
    expect(get?.query['page']).toBeDefined();
  });

  it('honors --limit and --page', async () => {
    const result = await runCli(['member', 'list', '--limit', '5', '--page', '2'], {
      routes: baseRoutes({ 'GET /admin/members': memberPagesRoute(3) }),
    });

    expect(result.exitCode).toBe(0);
    const get = result.requests.find((r) => r.path === '/admin/members');
    expect(get?.query['limit']).toBe('5');
    expect(get?.query['page']).toBe('2');
  });

  it('fetches every page with --all', async () => {
    // 3 members, 2 per page: exactly two requests, all rows rendered.
    const result = await runCli(['member', 'list', '--all', '--limit', '2'], {
      routes: baseRoutes({ 'GET /admin/members': memberPagesRoute(3) }),
    });

    expect(result.exitCode).toBe(0);
    const pages = result.requests.filter((r) => r.path === '/admin/members');
    expect(pages).toHaveLength(2);
    expect(result.stdout).toContain('member_1');
    expect(result.stdout).toContain('member_3');
  });
});

describe('member list --joined-after', () => {
  it('forwards joinedAfter as an ISO date and renders the results', async () => {
    const result = await runCli(
      ['member', 'list', '--joined-after', '2026-01-01T00:00:00Z'],
      {
        routes: baseRoutes({ 'GET /admin/members': memberPagesRoute(1) }),
      },
    );

    expect(result.exitCode).toBe(0);
    const get = result.requests.find((r) => r.path === '/admin/members');
    expect(get?.query['joinedAfter']).toBe('2026-01-01T00:00:00Z');
    expect(result.stdout).toContain('member_1');
  });
});
