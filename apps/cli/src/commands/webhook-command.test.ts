import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupCliTest, json, runCli } from '../test-support/cli-harness.js';
import { baseRoutes, WEBHOOK_ID } from '../test-support/fixtures.js';

afterEach(cleanupCliTest);

describe('webhook settings set', () => {
  it('sends defaultReaderRoleIds (the DTO field) and succeeds', async () => {
    const result = await runCli(
      ['webhook', 'settings', 'set', '--reader-role', '123456789012345678'],
      {
        routes: baseRoutes({
          'PUT /admin/inbound-webhooks/settings': () => json({ defaultReaderRoleIds: ['123456789012345678'] }),
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    const put = result.requests.find((r) => r.path === '/admin/inbound-webhooks/settings');
    expect(put?.body).toEqual({ defaultReaderRoleIds: ['123456789012345678'] });
  });
});

describe('webhook submissions', () => {
  it('converts --since durations to an ISO dateFrom', async () => {
    const result = await runCli(['webhook', 'submissions', 'contact-form', '--since', '24h'], {
      routes: baseRoutes({
        [`GET /inbound-webhooks/${WEBHOOK_ID}/submissions`]: () =>
          json({ submissions: [], total: 0, limit: 30, offset: 0 }),
      }),
    });

    expect(result.exitCode).toBe(0);
    const get = result.requests.find(
      (r) => r.path === `/inbound-webhooks/${WEBHOOK_ID}/submissions`,
    );
    const dateFrom = String(get?.query['dateFrom']);
    expect(dateFrom).not.toBe('24h');
    expect(Number.isNaN(Date.parse(dateFrom))).toBe(false);
  });
});

describe('webhook submissions export (nested grammar)', () => {
  it('runs the export when invoked as two tokens: submissions export <webhook>', async () => {
    const target = join(await mkdtemp(join(tmpdir(), 'mcid-export-')), 'subs.csv');
    const result = await runCli(
      ['webhook', 'submissions', 'export', 'contact-form', '--file', target],
      {
        routes: baseRoutes({
          [`GET /inbound-webhooks/${WEBHOOK_ID}/submissions`]: () =>
            json({ submissions: [], total: 0, limit: 200, offset: 0 }),
        }),
      },
    );

    // The export action ran (submissions endpoint hit, file written), and
    // "export" was not treated as a webhook name.
    expect(result.exitCode).toBe(0);
    expect(
      result.requests.some((r) => r.path === `/inbound-webhooks/${WEBHOOK_ID}/submissions`),
    ).toBe(true);
    expect(result.stdout).toContain('Exported');
  });
});

