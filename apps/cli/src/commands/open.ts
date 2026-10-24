import { Command } from 'commander';
import { openBrowser } from '../browser.js';
import { configPath, loadConfig, resolveProfileName } from '../config.js';
import { defaultKeyProvider } from '../crypto-store.js';
import { exitWithError } from '../errors.js';
import { ApiClient } from '../lib/client.js';
import { colors } from '../lib/tui.js';
import { resolveProject, resolveServer, resolveWebhook } from '../lib/resolver.js';
import { resolveSession } from '../session.js';

export function registerOpenCommand(program: Command): void {
  program
    .command('open [area] [id]')
    .description('Open an MCID dashboard page in the browser (project, server, webhook, docs)')
    .option('--web <url>', 'Web dashboard base URL (or set MCID_WEB_URL)')
    .option('--profile <name>', 'Profile to use')
    .action(async (area?: string, id?: string, options?: { web?: string; profile?: string }) => {
      try {
        const config = await loadConfig(configPath());
        const profileName = resolveProfileName(config, options?.profile);
        const session = await resolveSession(config, profileName, defaultKeyProvider());
        const client = new ApiClient(session);

        let targetPath = '';
        if (!area || area === 'dashboard') {
          targetPath = '/dashboard';
        } else if (area === 'docs') {
          targetPath = '/docs';
        } else if (area === 'project') {
          if (id) {
            const p = await resolveProject(client, id);
            targetPath = `/dashboard/projects/${encodeURIComponent(p.id)}`;
          } else {
            targetPath = '/dashboard/projects';
          }
        } else if (area === 'server') {
          if (id) {
            const s = await resolveServer(client, id);
            targetPath = `/dashboard/servers/${encodeURIComponent(s.id)}`;
          } else {
            targetPath = '/dashboard/servers';
          }
        } else if (area === 'webhook' || area === 'webhooks') {
          if (id) {
            const w = await resolveWebhook(client, id);
            targetPath = `/dashboard/inbound-webhooks/${encodeURIComponent(w.id)}`;
          } else {
            targetPath = '/dashboard/inbound-webhooks';
          }
        } else {
          targetPath = `/${area}`;
        }

        // The dashboard lives in the web app, a different origin from the
        // API in the documented deployment; only the web URL can serve it.
        const webBase = options?.web || process.env.MCID_WEB_URL || session.baseUrl;
        const fullUrl = `${webBase}${targetPath}`;
        process.stdout.write(`Opening ${colors.cyan(fullUrl)} in browser...\n`);
        const opened = await openBrowser(fullUrl);
        if (!opened) {
          process.stdout.write(`Could not open browser automatically. Please visit: ${fullUrl}\n`);
        }
      } catch (err) {
        exitWithError('open', err);
      }
    });
}
