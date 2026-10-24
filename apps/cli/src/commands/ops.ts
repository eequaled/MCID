import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { configPath, loadConfig, resolveProfileName } from '../config.js';
import { defaultKeyProvider } from '../crypto-store.js';
import { CliError, ExitCode, exitWithError } from '../errors.js';
import {
  normalizeAuditLogs,
  normalizeAuthFailures,
  normalizeGrowthSeries,
  normalizeRoleStats,
  normalizeServerStats,
  normalizeUsage,
} from '../lib/api-normalize.js';
import { ApiClient } from '../lib/client.js';
import { confirmAction, confirmDestructive } from '../lib/confirm.js';
import {
  formatAge,
  printJson,
  printKeyValue,
  printSuccess,
  printTable,
  toCsv,
} from '../lib/output.js';
import { resolveMember, resolveProject, resolveServer } from '../lib/resolver.js';
import { parseSince } from '../lib/time.js';
import { colors, formatSparkline } from '../lib/tui.js';
import { resolveSession } from '../session.js';

interface HealthResponse {
  api: { status: string; uptime: number; responseTime: number };
  database: { status: string; queryTime: number; connections?: number };
  redis?: { status: string; hitRate?: number; memoryUsed?: string };
  discord: { status: string; guilds?: number; latency?: number };
}

interface SyncStatusItem {
  serverId: string;
  status: string;
  /** SyncStatusDto field name. */
  lastSyncAt?: string | null;
}

export function registerOpsCommand(program: Command): void {
  // ── status ─────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Overview of system component health and Discord server sync')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const [health, syncServers] = await Promise.all([
          client.get<HealthResponse>('/admin/monitoring/health').catch((err) => {
            throw err;
          }),
          client.get<SyncStatusItem[]>('/admin/sync/status/all').catch(() => []),
        ]);

        if (options.json) {
          printJson({ health, syncServers });
          return;
        }

        process.stdout.write(`\n${colors.bold('MCID System Health & Ops Overview')}\n\n`);

        const isApiOk = health.api?.status === 'healthy';
        const isDbOk = health.database?.status === 'connected';
        const isRedisOk = !health.redis || health.redis.status === 'connected';
        const isDiscordOk = health.discord?.status === 'connected';

        const apiText = isApiOk
          ? colors.green('healthy')
          : colors.red(health.api?.status || 'down');
        const dbText = isDbOk
          ? colors.green('connected')
          : colors.red(health.database?.status || 'down');
        const redisText = isRedisOk
          ? colors.green('connected')
          : colors.red(health.redis?.status || 'down');
        const discordText = isDiscordOk
          ? colors.green('connected')
          : colors.red(health.discord?.status || 'down');

        process.stdout.write(
          `  API:         ${apiText} (${health.api?.responseTime ?? 0}ms latency)\n`,
        );
        process.stdout.write(
          `  Database:    ${dbText} (${health.database?.queryTime ?? 0}ms query time)\n`,
        );
        if (health.redis) {
          process.stdout.write(
            `  Redis:       ${redisText} (memory: ${health.redis.memoryUsed || 'n/a'})\n`,
          );
        }
        process.stdout.write(
          `  Discord:     ${discordText} (gateway latency: ${health.discord?.latency ?? 0}ms)\n`,
        );

        // The sync rows carry serverId + lastSyncAt only; resolve names here.
        const serverNames = new Map<string, string>();
        try {
          for (const s of await client.get<{ id: string; name?: string }[]>('/servers')) {
            serverNames.set(s.id, s.name ?? s.id);
          }
        } catch {
          // Names are cosmetic; ids still identify the rows.
        }

        process.stdout.write(`\n${colors.bold('Discord Servers Synchronization:')}\n`);
        if (syncServers.length === 0) {
          process.stdout.write(colors.dim('  No servers registered.\n'));
        } else {
          for (const s of syncServers) {
            let syncStatus = s.status;
            if (s.status === 'success') syncStatus = colors.green('success');
            else if (s.status === 'in_progress') syncStatus = colors.cyan('in_progress');
            else if (s.status === 'failed') syncStatus = colors.red('failed');
            else syncStatus = colors.yellow(s.status || 'never');

            process.stdout.write(
              `  ${colors.dim('•')} ${colors.bold(serverNames.get(s.serverId) || s.serverId)}: ${syncStatus} (last sync: ${formatAge(s.lastSyncAt)})\n`,
            );
          }
        }
        process.stdout.write('\n');

        // Exit 5 means the CLI could not complete the check. Redis is an
        // optional component: deployments without it stay healthy, with a
        // warning line only. The API and the database are the core.
        const coreHealthy = isApiOk && isDbOk;
        if (!isRedisOk) {
          process.stdout.write(
            `  ${colors.yellow('!')} Redis is ${health.redis?.status ?? 'unavailable'} (optional component — caching is degraded)\n\n`,
          );
        }
        if (!coreHealthy) {
          process.exitCode = ExitCode.Unexpected;
        }
      } catch (err) {
        exitWithError('status', err);
      }
    });

  // ── monitor ────────────────────────────────────────────────────────
  const monitorCmd = program.command('monitor').description('Ops metrics and usage statistics');

  monitorCmd
    .command('usage')
    .description('View API requests per project and error rates')
    .option('--period <period>', 'Time window (7d, 30d, 90d)', '7d')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { period: string; profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const raw = await client.get(
          `/admin/monitoring/usage?period=${encodeURIComponent(options.period)}`,
        );
        const rows = normalizeUsage(raw);

        if (options.json) {
          printJson(raw);
          return;
        }

        const totalRequests = (raw as { totalRequests?: number }).totalRequests;

        if (rows.length === 0) {
          process.stdout.write(
            colors.dim(
              `No project-attributed API usage recorded in the last ${options.period}${totalRequests !== undefined ? ` (total requests: ${totalRequests})` : ''}.\n`,
            ),
          );
          return;
        }

        printTable({
          columns: [
            {
              header: 'PROJECT',
              key: 'projectName',
              format: (v) => colors.bold(String(v || '-')),
            },
            {
              header: 'REQUESTS',
              key: 'requests',
              align: 'right',
              format: (v) => String(v ?? 0),
            },
            {
              header: 'ERRORS',
              key: 'errors',
              align: 'right',
              format: (v) => String(v ?? 0),
            },
            {
              header: 'ERROR RATE',
              key: 'errorRate',
              align: 'right',
              format: (v) => `${Number(v ?? 0).toFixed(1)}%`,
            },
          ],
          data: rows,
        });
      } catch (err) {
        exitWithError('monitor usage', err);
      }
    });

  monitorCmd
    .command('auth-failures')
    .description('View recent authentication failures')
    .option('--since <date>', 'Filter events since date')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { since?: string; profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        let path = '/admin/monitoring/auth-failures';
        if (options.since) {
          path += `?dateFrom=${encodeURIComponent(parseSince(options.since, '--since'))}`;
        }
        const raw = await client.get(path);
        const list = normalizeAuthFailures(raw);

        if (options.json) {
          printJson(raw);
          return;
        }

        if (list.length === 0) {
          process.stdout.write(colors.dim('No authentication failures recorded.\n'));
          return;
        }

        printTable({
          columns: [
            {
              header: 'TIME',
              key: 'timestamp',
              format: (v) => formatAge(typeof v === 'string' ? v : undefined),
            },
            { header: 'REASON', key: 'reason', format: (v) => colors.red(String(v)) },
            { header: 'IP ADDRESS', key: 'ipAddress', format: (v) => String(v ?? '-') },
            { header: 'TARGET', key: 'target', format: (v) => String(v ?? '-') },
          ],
          data: list,
        });
      } catch (err) {
        exitWithError('monitor auth-failures', err);
      }
    });

  // ── audit ──────────────────────────────────────────────────────────
  const auditCmd = program.command('audit').description('Inspect audit logs of admin activities');

  auditCmd
    .command('list')
    .alias('ls')
    .description('List recent audit log entries')
    .option('--actor <member>', 'Filter by admin actor')
    .option(
      '--action <category>',
      'Filter by action category (auth, project, server, role, webhook, member, sync, permission, access)',
    )
    .option('--resource <resource>', 'Filter by resource/entity type')
    .option('--since <date>', 'Start date (ISO timestamp or 30m, 24h, 7d)')
    .option('--until <date>', 'End date')
    .option('--follow', 'Poll for new entries continuously')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (options: {
        actor?: string;
        action?: string;
        resource?: string;
        since?: string;
        until?: string;
        follow?: boolean;
        profile?: string;
        json?: boolean;
      }) => {
        try {
          const client = await getClient(options.profile);

          let actorId: string | undefined;
          if (options.actor) {
            const resolved = await resolveMember(client, options.actor);
            actorId = resolved.discordId;
          }

          const ACTION_CATEGORIES = [
            'auth',
            'project',
            'server',
            'role',
            'webhook',
            'member',
            'sync',
            'permission',
            'access',
          ];
          if (options.action && !ACTION_CATEGORIES.includes(options.action)) {
            throw new CliError(
              `Unknown action category "${options.action}". Expected one of: ${ACTION_CATEGORIES.join(', ')}`,
              ExitCode.Usage,
            );
          }

          const buildParams = () => {
            const params = new URLSearchParams();
            params.set('limit', '500');
            if (actorId) params.set('actorId', actorId);
            // --action filters the category; the row's action name is not filterable.
            if (options.action) params.set('actionType', options.action);
            if (options.since) params.set('dateFrom', parseSince(options.since, '--since'));
            if (options.until) params.set('dateTo', parseSince(options.until, '--until'));
            return params;
          };

          const fetchRaw = async () => client.get(`/admin/audit/logs?${buildParams().toString()}`);
          const fetchLogs = async () => {
            const rows = normalizeAuditLogs(await fetchRaw());
            return options.resource
              ? rows.filter(
                  (row) => row.entityType.toLowerCase() === options.resource!.toLowerCase(),
                )
              : rows;
          };

          const logs = await fetchLogs();

          if (options.json && !options.follow) {
            printJson(await fetchRaw());
            return;
          }

          const renderRow = (r: {
            timestamp: string;
            actor: string;
            action: string;
            entity: string;
          }) => {
            const time = formatAge(r.timestamp || undefined);
            process.stdout.write(
              `  [${colors.dim(time)}] ${colors.cyan(`@${r.actor}`)} ${colors.bold(r.action)} ${colors.dim(r.entity)}\n`,
            );
          };

          if (logs.length === 0) {
            process.stdout.write(colors.dim('No audit entries found.\n'));
          } else {
            for (const row of logs) {
              renderRow(row);
            }
          }

          if (options.follow) {
            let lastSeenId = logs[0]?.id;
            const interval = setInterval(async () => {
              try {
                const fresh = await fetchLogs();
                for (const row of fresh) {
                  if (row.id === lastSeenId) break;
                  renderRow(row);
                }
                if (fresh[0]) lastSeenId = fresh[0].id;
              } catch {
                // ignore polling hiccups
              }
            }, 3000);

            process.on('SIGINT', () => {
              clearInterval(interval);
              process.exit(0);
            });
          }
        } catch (err) {
          exitWithError('audit list', err);
        }
      },
    );

  auditCmd
    .command('export')
    .description('Export audit logs to CSV')
    .option('--file <path>', 'Destination CSV file path')
    .option('--profile <name>', 'Profile to use')
    .action(async (options: { file?: string; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const data = await client.get<Record<string, unknown>[] | string>(
          '/admin/audit/logs/export',
        );
        const csvContent = typeof data === 'string' ? data : toCsv(data);
        const defaultFilename = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
        const path = options.file || defaultFilename;
        await writeFile(path, csvContent, { encoding: 'utf8', mode: 0o600 });
        printSuccess(`Exported audit logs to ${path}`);
      } catch (err) {
        exitWithError('audit export', err);
      }
    });

  // ── stats ──────────────────────────────────────────────────────────
  const statsCmd = program.command('stats').description('Community and server statistics');

  statsCmd
    .command('members')
    .description('Member statistics and breakdown')
    .option('--server <server>', 'Specific Discord server')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { server?: string; profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        let path = '/admin/stats/members';
        if (options.server) {
          const s = await resolveServer(client, options.server);
          path += `?serverId=${encodeURIComponent(s.id)}`;
        }
        const stats = await client.get<Record<string, unknown>>(path);
        if (options.json) {
          printJson(stats);
          return;
        }
        printKeyValue(stats);
      } catch (err) {
        exitWithError('stats members', err);
      }
    });

  statsCmd
    .command('growth')
    .description('Community growth sparkline and trend over time')
    .option('--server <server>', 'Specific Discord server')
    .option('--period <period>', 'Growth period (30d, 90d, 1y)', '30d')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (options: { server?: string; period: string; profile?: string; json?: boolean }) => {
        try {
          const client = await getClient(options.profile);
          let path = `/admin/stats/members/growth?period=${encodeURIComponent(options.period)}`;
          if (options.server) {
            const s = await resolveServer(client, options.server);
            path += `&serverId=${encodeURIComponent(s.id)}`;
          }
          const data = await client.get(path);

          if (options.json) {
            printJson(data);
            return;
          }

          const values = normalizeGrowthSeries(data);

          process.stdout.write(`\n${colors.bold('Member Growth Trend')} (${options.period}):\n\n`);
          if (values.length === 0) {
            process.stdout.write(colors.dim('  No growth data recorded for this period.\n\n'));
            return;
          }
          const spark = formatSparkline(values);
          process.stdout.write(`  ${colors.green(spark)}\n\n`);
          const min = Math.min(...values);
          const max = Math.max(...values);
          const latest = values[values.length - 1] ?? 0;
          process.stdout.write(
            `  Min: ${min} | Max: ${max} | Current: ${colors.bold(String(latest))}\n\n`,
          );
        } catch (err) {
          exitWithError('stats growth', err);
        }
      },
    );

  statsCmd
    .command('roles')
    .description('Role distribution and assignment statistics')
    .option('--server <server>', 'Specific Discord server')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { server?: string; profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveServer(client, options.server);
        const raw = await client.get(
          `/admin/stats/roles?serverId=${encodeURIComponent(resolved.id)}`,
        );
        const roles = normalizeRoleStats(raw);

        if (options.json) {
          printJson(raw);
          return;
        }

        printTable({
          columns: [
            { header: 'ROLE', key: 'name', format: (v) => colors.bold(String(v)) },
            {
              header: 'MEMBERS',
              key: 'memberCount',
              align: 'right',
              format: (v) => String(v ?? 0),
            },
            {
              header: 'SHARE',
              key: 'percentage',
              align: 'right',
              format: (v) => (v === undefined ? '-' : `${Number(v).toFixed(1)}%`),
            },
          ],
          data: roles,
        });
      } catch (err) {
        exitWithError('stats roles', err);
      }
    });

  statsCmd
    .command('servers')
    .description('Server comparison statistics')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const raw = await client.get('/admin/stats/servers');
        const res = normalizeServerStats(raw);
        if (options.json) {
          printJson(raw);
          return;
        }
        printTable({
          columns: [
            {
              header: 'SERVER',
              key: 'serverName',
              format: (v) => colors.bold(String(v)),
            },
            {
              header: 'MEMBERS',
              key: 'memberCount',
              align: 'right',
              format: (v) => String(v ?? 0),
            },
            { header: 'ROLES', key: 'roleCount', align: 'right', format: (v) => String(v ?? 0) },
            {
              header: 'SYNC',
              key: 'syncStatus',
              format: (v) => {
                const st = String(v ?? 'never');
                if (st === 'success') return colors.green(st);
                if (st === 'failed') return colors.red(st);
                return colors.yellow(st);
              },
            },
          ],
          data: res,
        });
      } catch (err) {
        exitWithError('stats servers', err);
      }
    });

  statsCmd
    .command('overlap')
    .description('Cross-server member overlap statistics')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const res = await client.get<Record<string, unknown>>('/admin/stats/cross-server');
        printJson(res);
      } catch (err) {
        exitWithError('stats overlap', err);
      }
    });

  statsCmd
    .command('export')
    .description('Export general statistics to CSV or JSON')
    .option(
      '--type <type>',
      'Report to export (members, growth, roles, servers, cross-server)',
      'members',
    )
    .option('--server <server>', 'Server scope (required for type=roles)')
    .option('-o, --output <format>', 'Format (csv|json)', 'csv')
    .option('--file <path>', 'Destination file path')
    .option('--profile <name>', 'Profile to use')
    .action(
      async (options: {
        type?: string;
        server?: string;
        output?: 'csv' | 'json';
        file?: string;
        profile?: string;
      }) => {
        try {
          const client = await getClient(options.profile);
          const format = options.output || 'csv';
          const params = new URLSearchParams({
            type: options.type || 'members',
            format,
          });
          if (options.server) {
            const s = await resolveServer(client, options.server);
            params.set('serverId', s.id);
          }

          const data = await client.get<Record<string, unknown>[] | string>(
            `/admin/stats/export?${params.toString()}`,
          );
          const content =
            typeof data === 'string'
              ? data
              : format === 'json'
                ? JSON.stringify(data, null, 2)
                : toCsv(data);
          const target =
            options.file ||
            `stats-${options.type || 'members'}-${new Date().toISOString().slice(0, 10)}.${format}`;

          await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
          printSuccess(`Exported ${options.type || 'members'} stats to ${target}`);
        } catch (err) {
          exitWithError('stats export', err);
        }
      },
    );

  // ── settings ───────────────────────────────────────────────────────
  const settingsCmd = program
    .command('settings')
    .description('Inspect and configure MCID settings');

  settingsCmd
    .command('get')
    .description('View effective settings (shows env vs DB values)')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const settings = await client.get<Record<string, unknown>>('/admin/settings');
        if (options.json) {
          printJson(settings);
          return;
        }
        printJson(settings);
      } catch (err) {
        exitWithError('settings get', err);
      }
    });

  settingsCmd
    .command('set <pairs...>')
    .description('Update editable settings (e.g. cache.permissionTtlMs=60000)')
    .option('--yes', 'Skip confirmation prompt')
    .option('--profile <name>', 'Profile to use')
    .action(async (pairs: string[], options: { yes?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const patchObj: Record<string, unknown> = {};
        const allowedPaths = new Set([
          'cache.permissionTtlMs',
          'cache.statsTtlMs',
          'rateLimit.maxWebhooksPerProject',
          'preferences.memberActivityThresholdDays',
        ]);

        for (const pair of pairs) {
          const [k, v] = pair.split('=');
          if (!k || v === undefined) {
            throw new CliError(
              `Invalid setting format "${pair}". Expected <key>=<value>`,
              ExitCode.Usage,
            );
          }
          if (!allowedPaths.has(k)) {
            throw new CliError(
              `Setting "${k}" is not editable. Editable settings: ${[...allowedPaths].join(', ')}`,
              ExitCode.Usage,
            );
          }

          const parsedVal = !isNaN(Number(v))
            ? Number(v)
            : v === 'true'
              ? true
              : v === 'false'
                ? false
                : v;

          // Nested key support, e.g. cache.permissionTtlMs
          const [grp = '', sub = ''] = k.split('.');
          if (!patchObj[grp]) patchObj[grp] = {};
          (patchObj[grp] as Record<string, unknown>)[sub] = parsedVal;
        }

        process.stdout.write(`${colors.bold('Applying settings updates:')}\n`);
        const current = await client.get<Record<string, unknown>>('/admin/settings');
        const readValue = (path: string): unknown =>
          path.split('.').reduce<unknown>((value, part) => {
            if (!value || typeof value !== 'object') return undefined;
            const node = (value as Record<string, unknown>)[part];
            return node && typeof node === 'object' && 'value' in node
              ? (node as { value: unknown }).value
              : node;
          }, current);
        for (const [k, v] of Object.entries(patchObj)) {
          for (const [field, next] of Object.entries(v as Record<string, unknown>)) {
            const path = `${k}.${field}`;
            process.stdout.write(
              `  ${colors.cyan('●')} ${path}: ${JSON.stringify(readValue(path))} → ${JSON.stringify(next)}\n`,
            );
          }
        }

        if (!(await confirmAction('Apply these setting changes?', options.yes))) return;

        await client.patch('/admin/settings', patchObj);
        printSuccess('Settings updated successfully');
      } catch (err) {
        exitWithError('settings set', err);
      }
    });

  settingsCmd
    .command('reset')
    .description('Reset ALL settings overrides back to environment defaults')
    .option('--yes', 'Skip confirmation prompt')
    .option('--profile <name>', 'Profile to use')
    .action(async (options: { yes?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        // The API clears every override; say so, so nobody expects per-key reset.
        if (
          !(await confirmAction(
            'Reset ALL settings overrides to environment defaults?',
            options.yes,
          ))
        ) {
          return;
        }

        await client.post('/admin/settings/reset');
        printSuccess('All settings overrides reset to defaults');
      } catch (err) {
        exitWithError('settings reset', err);
      }
    });

  // ── discord-webhook ────────────────────────────────────────────────
  const discordWhCmd = program
    .command('discord-webhook')
    .description('Manage Discord notification webhooks');

  discordWhCmd
    .command('list')
    .alias('ls')
    .description('List Discord webhooks for a project')
    .requiredOption('--project <project>', 'Project name or ID')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { project: string; profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, options.project);
        // The endpoint returns {webhooks, total, limit, offset}; page until done.
        const pageSize = 100;
        const webhooks: Record<string, unknown>[] = [];
        for (let offset = 0; ; offset += pageSize) {
          const page = await client.get<{
            webhooks?: Record<string, unknown>[];
            total?: number;
          }>(
            `/admin/projects/${encodeURIComponent(resolved.id)}/webhooks?limit=${pageSize}&offset=${offset}`,
          );
          webhooks.push(...(page.webhooks ?? []));
          if (
            (page.webhooks ?? []).length < pageSize ||
            (page.total !== undefined && webhooks.length >= page.total)
          ) {
            break;
          }
        }

        if (options.json) {
          printJson(webhooks);
          return;
        }

        printTable({
          columns: [
            { header: 'ID', key: 'id', format: (v) => colors.dim(String(v)) },
            { header: 'NAME', key: 'name', format: (v) => colors.bold(String(v ?? '-')) },
            { header: 'CHANNEL', key: 'channelId', format: (v) => colors.dim(String(v ?? '-')) },
          ],
          data: webhooks,
        });
      } catch (err) {
        exitWithError('discord-webhook list', err);
      }
    });

  discordWhCmd
    .command('get <id>')
    .description('Get a Discord webhook details')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const wh = await client.get<Record<string, unknown>>(
          `/admin/webhooks/${encodeURIComponent(id)}`,
        );
        if (options.json) {
          printJson(wh);
          return;
        }
        printKeyValue(wh);
      } catch (err) {
        exitWithError('discord-webhook get', err);
      }
    });

  discordWhCmd
    .command('delete <id>')
    .alias('rm')
    .description('Delete a Discord webhook')
    .option('--yes', 'Skip confirmation prompt')
    .option('--profile <name>', 'Profile to use')
    .action(async (id: string, options: { yes?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        await confirmDestructive({
          resourceType: 'discord-webhook',
          resourceName: id,
          yesFlag: options.yes,
        });
        await client.delete(`/admin/webhooks/${encodeURIComponent(id)}`);
        printSuccess(`Discord webhook "${id}" deleted`);
      } catch (err) {
        exitWithError('discord-webhook delete', err);
      }
    });
}

async function getClient(profileFlag?: string): Promise<ApiClient> {
  const config = await loadConfig(configPath());
  const profileName = resolveProfileName(config, profileFlag);
  const session = await resolveSession(config, profileName, defaultKeyProvider());
  return new ApiClient(session);
}
