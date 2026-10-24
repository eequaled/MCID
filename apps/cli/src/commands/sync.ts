import { Command } from 'commander';
import { configPath, loadConfig, resolveProfileName } from '../config.js';
import { defaultKeyProvider } from '../crypto-store.js';
import { CliError, ExitCode, exitWithError } from '../errors.js';
import {
  normalizeSyncChanges,
  normalizeSyncLogs,
  normalizeSyncStatus,
  unwrapArray,
} from '../lib/api-normalize.js';
import { ApiClient } from '../lib/client.js';
import { formatAge, printJson, printSuccess, printTable, toCsv } from '../lib/output.js';
import { resolveServer } from '../lib/resolver.js';
import { colors } from '../lib/tui.js';
import { resolveSession } from '../session.js';

export function registerSyncCommand(program: Command): void {
  const syncCmd = program
    .command('sync')
    .description('Run, inspect, and monitor Discord server sync');

  // sync run [--server <s>] [--wait] [--timeout <s>]
  syncCmd
    .command('run')
    .description('Trigger a full Discord synchronization')
    .option('--server <server>', 'Server to sync (defaults to main server)')
    .option('--wait', 'Wait for sync to complete with live progress')
    .option('--timeout <seconds>', 'Maximum seconds to wait (default 120)', '120')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (options: {
        server?: string;
        wait?: boolean;
        timeout: string;
        profile?: string;
        json?: boolean;
      }) => {
        try {
          const client = await getClient(options.profile);
          const resolved = await resolveServer(client, options.server);

          const trigger = await client.post<{
            syncLogId?: string;
            id?: string;
            status?: string;
            results?: { serverId: string; syncId?: number; error?: string }[];
          }>('/admin/sync/full', { serverIds: [resolved.id] });

          const result = trigger.results?.[0];
          if (result?.error) {
            throw new CliError(
              `Sync could not be queued for "${resolved.name}": ${result.error}`,
              ExitCode.Rejected,
            );
          }
          const syncLogId = trigger.syncLogId || trigger.id || String(result?.syncId ?? '');

          if (!options.wait) {
            if (options.json) {
              printJson({ ...trigger, server: resolved });
              return;
            }
            printSuccess(
              `Sync queued for "${resolved.name}"`,
              syncLogId
                ? `follow logs with: mcid-cli sync logs --server ${resolved.id}`
                : undefined,
            );
            return;
          }

          // Wait for sync to complete
          const timeoutMs = parseInt(options.timeout, 10) * 1000;
          const startTime = Date.now();
          const spinChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
          let spinIdx = 0;

          process.stdout.write(`Syncing server "${colors.bold(resolved.name)}"...\n`);

          while (Date.now() - startTime < timeoutMs) {
            const statusRes = normalizeSyncStatus(
              await client.get(`/admin/sync/status?serverId=${encodeURIComponent(resolved.id)}`),
            );

            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            const spin = spinChars[spinIdx++ % spinChars.length] ?? '•';

            if (process.stdout.isTTY) {
              process.stdout.write(
                `\r  ${colors.cyan(spin)} [${elapsedSec}s] Status: ${statusRes.status} (members: ${statusRes.membersSynced}, roles: ${statusRes.rolesSynced})   `,
              );
            }

            if (statusRes.status === 'success') {
              if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
              printSuccess(
                `Synced ${resolved.name} in ${elapsedSec}s: ${statusRes.membersSynced} members, ${statusRes.rolesSynced} roles`,
              );
              if (options.json) {
                printJson(statusRes);
              }
              return;
            }

            if (statusRes.status === 'failed') {
              if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
              throw new CliError(
                `Sync failed for "${resolved.name}"\n  hint: check error logs with \`mcid-cli sync logs --server ${resolved.id}\``,
                ExitCode.Rejected,
              );
            }

            await new Promise((r) => setTimeout(r, 1500));
          }

          if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
          throw new CliError(
            `Sync timed out after ${options.timeout}s\n  hint: check status with \`mcid-cli sync status --server ${resolved.id}\``,
            ExitCode.Unexpected,
          );
        } catch (err) {
          exitWithError('sync run', err);
        }
      },
    );

  // sync status [--server <s>] [--all]
  syncCmd
    .command('status')
    .description('View sync status for a server or all servers')
    .option('--server <server>', 'Specific server')
    .option('--all', 'Show sync status across all servers')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .option('-o, --output <format>', 'Output format (table|json|csv)', 'table')
    .action(
      async (options: {
        server?: string;
        all?: boolean;
        profile?: string;
        json?: boolean;
        output?: 'table' | 'json' | 'csv';
      }) => {
        try {
          const client = await getClient(options.profile);

          if (options.all) {
            const raw = await client.get('/admin/sync/status/all');
            const list = unwrapArray<unknown>(raw, ['servers', 'data']).map(normalizeSyncStatus);
            const outFormat = options.json ? 'json' : options.output || 'table';
            if (outFormat === 'json') {
              printJson(raw);
              return;
            }
            if (outFormat === 'csv') {
              process.stdout.write(toCsv(list));
              return;
            }

            printTable({
              columns: [
                {
                  header: 'SERVER',
                  format: (_, r) => String(r['serverName'] || r['serverId'] || '-'),
                },
                {
                  header: 'STATUS',
                  format: (_, r) => {
                    const st = String(r['status'] || 'never');
                    if (st === 'success') return colors.green('success');
                    if (st === 'in_progress') return colors.cyan('in_progress');
                    if (st === 'failed') return colors.red('failed');
                    return colors.yellow(st);
                  },
                },
                {
                  header: 'LAST SYNC',
                  format: (_, r) => formatAge(r['lastSyncAt'] as string | null | undefined),
                },
                {
                  header: 'MEMBERS',
                  key: 'membersSynced',
                  format: (v) => String(v ?? '-'),
                },
                {
                  header: 'ROLES',
                  key: 'rolesSynced',
                  format: (v) => String(v ?? '-'),
                },
              ],
              data: list as unknown as Record<string, unknown>[],
            });
            return;
          }

          const resolved = await resolveServer(client, options.server);
          let raw: unknown;
          try {
            raw = await client.get(
              `/admin/sync/status?serverId=${encodeURIComponent(resolved.id)}`,
            );
          } catch (err) {
            if (err instanceof CliError && err.exitCode === ExitCode.NotFound) {
              raw = { serverId: resolved.id, status: 'never' };
            } else {
              throw err;
            }
          }
          const status = normalizeSyncStatus(raw);

          if (options.json) {
            printJson(raw);
            return;
          }

          printTable({
            columns: [
              { header: 'SERVER', format: () => resolved.name },
              {
                header: 'STATUS',
                format: () => {
                  if (status.status === 'success') return colors.green('success');
                  if (status.status === 'in_progress') return colors.cyan('in_progress');
                  if (status.status === 'failed') return colors.red('failed');
                  return colors.yellow(status.status || 'never');
                },
              },
              {
                header: 'LAST SYNC',
                format: () => formatAge(status.lastSyncAt),
              },
              { header: 'MEMBERS', key: 'membersSynced', format: (v) => String(v ?? '-') },
              { header: 'ROLES', key: 'rolesSynced', format: (v) => String(v ?? '-') },
            ],
            data: [status as unknown as Record<string, unknown>],
          });
        } catch (err) {
          exitWithError('sync status', err);
        }
      },
    );

  // sync logs [--server <s>]
  syncCmd
    .command('logs')
    .description('View recent sync execution logs')
    .option('--server <server>', 'Filter by server (defaults to main server)')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { server?: string; profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveServer(client, options.server);
        const raw = await client.get(
          `/admin/sync/logs?serverId=${encodeURIComponent(resolved.id)}`,
        );
        const logs = normalizeSyncLogs(raw);

        if (options.json) {
          printJson(raw);
          return;
        }

        printTable({
          columns: [
            { header: 'LOG ID', key: 'id', format: (v) => colors.dim(String(v)) },
            { header: 'TYPE', key: 'syncType', format: (v) => String(v) },
            {
              header: 'STATUS',
              format: (_, r) => {
                const st = String(r['status'] || '');
                if (st === 'success') return colors.green('success');
                if (st === 'failed') return colors.red('failed');
                return colors.yellow(st);
              },
            },
            {
              header: 'STARTED',
              key: 'startedAt',
              format: (v) => formatAge(typeof v === 'string' ? v : undefined),
            },
            { header: 'MEMBERS', key: 'membersSynced', format: (v) => String(v ?? '-') },
            { header: 'ROLES', key: 'rolesSynced', format: (v) => String(v ?? '-') },
          ],
          data: logs as unknown as Record<string, unknown>[],
        });
      } catch (err) {
        exitWithError('sync logs', err);
      }
    });

  // sync changes <syncLogId> [--type added|removed|updated]
  syncCmd
    .command('changes <syncLogId>')
    .description('View itemized member and role changes for a sync run')
    .option('--type <type>', 'Filter by what happened: added, removed, updated')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .option('-o, --output <format>', 'Output format (table|json|csv)', 'table')
    .action(
      async (
        syncLogId: string,
        options: {
          type?: string;
          profile?: string;
          json?: boolean;
          output?: 'table' | 'json' | 'csv';
        },
      ) => {
        try {
          const client = await getClient(options.profile);
          // Page with limit/offset until the API's `total` is covered; the
          // endpoint defaults to 100 rows and --type maps to `action`.
          const pageSize = 100;
          const changes: ReturnType<typeof normalizeSyncChanges> = [];
          for (let offset = 0; ; offset += pageSize) {
            const params = new URLSearchParams({
              limit: String(pageSize),
              offset: String(offset),
            });
            if (options.type) params.set('action', options.type);
            const raw = await client.get(
              `/admin/sync/logs/${encodeURIComponent(syncLogId)}/changes?${params.toString()}`,
            );
            const pageRows = normalizeSyncChanges(raw);
            changes.push(...pageRows);
            const total = (raw as { total?: number }).total;
            if (pageRows.length < pageSize || (total !== undefined && changes.length >= total)) {
              break;
            }
          }

          const outFormat = options.json ? 'json' : options.output || 'table';
          if (outFormat === 'json') {
            printJson({ changes, total: changes.length });
            return;
          }
          if (outFormat === 'csv') {
            process.stdout.write(toCsv(changes));
            return;
          }

          printTable({
            columns: [
              { header: 'ENTITY', key: 'entityType', format: (v) => colors.bold(String(v)) },
              { header: 'ACTION', key: 'action', format: (v) => String(v) },
              { header: 'IDENTIFIER', key: 'entityId', format: (v) => colors.dim(String(v)) },
              {
                header: 'DESCRIPTION',
                format: (_, r) => String(r['description'] ?? r['entityName'] ?? '-'),
              },
            ],
            data: changes,
          });
        } catch (err) {
          exitWithError('sync changes', err);
        }
      },
    );
}

async function getClient(profileFlag?: string): Promise<ApiClient> {
  const config = await loadConfig(configPath());
  const profileName = resolveProfileName(config, profileFlag);
  const session = await resolveSession(config, profileName, defaultKeyProvider());
  return new ApiClient(session);
}
