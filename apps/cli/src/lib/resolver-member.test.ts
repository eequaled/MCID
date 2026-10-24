import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '../test-support/cli-harness.js';
import { ApiClient } from './client.js';
import { CliError, ExitCode } from '../errors.js';
import { resolveMember } from './resolver.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function clientWithSearchResult(rows: unknown[]) {
  vi.stubGlobal('fetch', async () =>
    json({ data: rows, total: rows.length, page: 1, limit: 100, totalPages: 1 }),
  );
  return new ApiClient({
    profileName: 'test',
    baseUrl: 'http://localhost:3000',
    token: 'test-token',
  });
}

describe('resolveMember', () => {
  it('throws NotFound when no member matches the username', async () => {
    const client = clientWithSearchResult([]);

    let thrown: unknown;
    try {
      await resolveMember(client, '@ghost_user');
    } catch (err) {
      thrown = err;
    }

    // A typo must surface as "not found", never as a fabricated
    // {discordId: "ghost_user"} that later prints as "denied".
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(ExitCode.NotFound);
  });

  it('matches on globalName (list rows have no displayName)', async () => {
    const client = clientWithSearchResult([
      { memberId: '333333333333333333', username: 'jd', globalName: 'John Doe' },
    ]);

    const resolved = await resolveMember(client, 'John Doe');
    expect(resolved.discordId).toBe('333333333333333333');
    expect(resolved.username).toBe('jd');
  });

  it('searches with a full page so members beyond the 20-row default are found', async () => {
    let searchedWith: URL | undefined;
    vi.stubGlobal('fetch', async (input: string | URL) => {
      searchedWith = new URL(String(input));
      return json({ data: [], total: 0, page: 1, limit: 100, totalPages: 0 });
    });
    const client = new ApiClient({
      profileName: 'test',
      baseUrl: 'http://localhost:3000',
      token: 'test-token',
    });

    await resolveMember(client, '@someone').catch(() => undefined);
    expect(searchedWith?.searchParams.get('limit')).toBe('100');
  });
});
