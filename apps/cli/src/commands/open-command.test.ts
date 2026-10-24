import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../browser.js', () => ({
  openBrowser: vi.fn(async () => true),
}));

import { openBrowser } from '../browser.js';
import { cleanupCliTest, runCli } from '../test-support/cli-harness.js';
import { baseRoutes } from '../test-support/fixtures.js';

afterEach(cleanupCliTest);
vi.mocked(openBrowser).mockClear();

describe('open', () => {
  it('opens the web dashboard URL passed with --web, not the API host', async () => {
    const result = await runCli(
      ['open', '--web', 'https://mcid-web.example.com'],
      { routes: baseRoutes() },
    );

    expect(result.exitCode).toBe(0);
    expect(openBrowser).toHaveBeenCalledWith('https://mcid-web.example.com/dashboard');
  });

  it('uses MCID_WEB_URL when no flag is given', async () => {
    const result = await runCli(['open', 'project', 'Portal'], {
      routes: baseRoutes(),
      env: { MCID_WEB_URL: 'https://panel.example.com' },
    });

    expect(result.exitCode).toBe(0);
    expect(openBrowser).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/panel\.example\.com\/dashboard\/projects\//),
    );
  });
});
