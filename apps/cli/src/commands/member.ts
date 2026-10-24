import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { configPath, loadConfig, normalizeBaseUrl, resolveProfileName } from '../config.js';
import { defaultKeyProvider } from '../crypto-store.js';
import { CliError, ExitCode, exitWithError } from '../errors.js';
import { ApiClient } from '../lib/client.js';
import {
  formatAge,
  formatDate,
  printJson,
  printQuiet,
  printSuccess,
  printTable,
  toCsv,
} from '../lib/output.js';
import { normalizeMemberDetail, normalizeMemberList, unwrapArray } from '../lib/api-normalize.js';
import { resolveMember, resolveServer } from '../lib/resolver.js';
import { colors } from '../lib/tui.js';
import { resolveSession } from '../session.js';
import { resolveProjectKey } from './dev.js';

function sourceOf(
  code: string,
  sources:
    | {
        global?: string[];
        server?: string[];
        hierarchy?: string[];
        inherited?: string[];
      }
    | undefined,
): string {
  if (sources?.global?.includes(code)) return 'global role';
  if (sources?.server?.includes(code)) return 'server role';
  if (sources?.hierarchy?.includes(code)) return 'role hierarchy';
  if (sources?.inherited?.includes(code)) return 'inherited role';
  return 'direct grant';
}

export function registerMemberCommand(program: Command): void {
  const memberCmd = program
    .command('member')
    .description('Search members, view cross-server memberships, and check permissions');

  // member list / ls
  const listAction = async (options: {
    server?: string;
    role?: string[];
    search?: string;
    joinedAfter?: string;
    limit?: string;
    page?: string;
    all?: boolean;
    crossServer?: boolean;
    profile?: string;
    json?: boolean;
    output?: 'table' | 'json' | 'csv';
    quiet?: boolean;
  }) => {
    try {
      const client = await getClient(options.profile);

      if (options.crossServer) {
        const raw = await client.get('/admin/members/cross-server');
        const res = normalizeMemberList(raw);

        if (options.quiet) {
          printQuiet(res.map((m) => m.memberId));
          return;
        }
        if (options.json || options.output === 'json') {
          printJson(raw);
          return;
        }

        const crossServerRows = res.map((m) => ({
          memberId: m.memberId,
          username: m.username,
          serversCount: m.serversCount,
          servers: m.serverNames.join(', '),
        }));

        if (options.output === 'csv') {
          process.stdout.write(toCsv(crossServerRows));
          return;
        }

        printTable({
          columns: [
            { header: 'DISCORD ID', key: 'memberId', format: (v) => colors.dim(String(v)) },
            { header: 'USERNAME', key: 'username', format: (v) => colors.bold(`@${v}`) },
            { header: 'SERVERS', key: 'serversCount', format: (v) => `${v} server(s)` },
            { header: 'MEMBERSHIPS', key: 'servers' },
          ],
          data: crossServerRows,
        });
        return;
      }

      const resolved = await resolveServer(client, options.server);
      // The API defaults to 20 rows per page; ask for a full page and page
      // through with --all instead of silently truncating.
      const limit = Math.min(100, Math.max(1, Number(options.limit ?? 100) || 100));
      const page = Math.max(1, Number(options.page ?? 1) || 1);
      const members: ReturnType<typeof normalizeMemberList> = [];
      for (let current = page; ; current += 1) {
        const params = new URLSearchParams({
          serverId: resolved.id,
          page: String(current),
          limit: String(limit),
        });
        if (options.search) params.set('search', options.search);
        if (options.joinedAfter) params.set('joinedAfter', options.joinedAfter);
        if (options.role && options.role.length > 0) {
          for (const r of options.role) params.append('roleId', r);
        }
        const raw = await client.get(`/admin/members?${params.toString()}`);
        const pageRows = normalizeMemberList(raw);
        members.push(...pageRows);
        if (!options.all || pageRows.length < limit) break;
      }

      if (options.quiet) {
        printQuiet(members.map((m) => m.memberId));
        return;
      }

      const outFormat = options.json ? 'json' : options.output || 'table';
      if (outFormat === 'json') {
        printJson(members);
        return;
      }

      const tableRows = members.map((m) => ({
        memberId: m.memberId,
        username: m.username,
        nickname: m.displayName || '-',
        roles: m.roles.join(', '),
        joinedAt: m.joinedAt,
      }));

      if (outFormat === 'csv') {
        process.stdout.write(toCsv(tableRows));
        return;
      }

      printTable({
        columns: [
          { header: 'DISCORD ID', key: 'memberId', format: (v) => colors.dim(String(v)) },
          { header: 'USERNAME', key: 'username', format: (v) => colors.bold(`@${v}`) },
          { header: 'NICKNAME', key: 'nickname' },
          {
            header: 'ROLES',
            key: 'roles',
            format: (v) => (v ? String(v) : colors.dim('none')),
          },
          {
            header: 'JOINED',
            key: 'joinedAt',
            format: (v) => colors.dim(formatAge(typeof v === 'string' ? v : undefined)),
          },
        ],
        data: tableRows,
      });
    } catch (err) {
      exitWithError('member list', err);
    }
  };

  memberCmd
    .command('list')
    .alias('ls')
    .description('List members on a Discord server with optional filters')
    .option('--server <server>', 'Discord server (defaults to main server)')
    .option('--role <role...>', 'Filter by role ID')
    .option('--search <query>', 'Search username, nickname, or ID')
    .option('--joined-after <date>', 'Filter members joined after ISO date')
    .option('--limit <n>', 'Rows per page, 1-100 (default 100)')
    .option('--page <n>', 'Page number to start from (default 1)')
    .option('--all', 'Fetch every page, not just the first')
    .option('--cross-server', 'Show members across all servers')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .option('-o, --output <format>', 'Output format (table|json|csv)', 'table')
    .option('-q, --quiet', 'Only print Discord IDs')
    .action(listAction);

  // member get <member>
  memberCmd
    .command('get <member>')
    .description('Get member details and server roles card')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (memberArg: string, options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveMember(client, memberArg);
        const raw = await client.get(
          `/admin/members/${encodeURIComponent(resolved.discordId)}/servers`,
        );

        if (options.json) {
          printJson(raw);
          return;
        }

        const m = normalizeMemberDetail(raw);
        const memberId = m.memberId || resolved.discordId;
        const avatar = (raw as { avatar?: string | null }).avatar;

        // Render readable card
        process.stdout.write(`\n${colors.bold(`@${m.username}`)} (${colors.dim(memberId)})\n`);
        if (m.displayName) {
          process.stdout.write(`Nickname: ${m.displayName}\n`);
        }
        if (avatar) {
          process.stdout.write(`Avatar:   ${colors.dim(avatar)}\n`);
        }
        process.stdout.write('\n');

        process.stdout.write(`${colors.bold('Server Memberships & Roles:')}\n`);
        const serverList = unwrapArray<{
          serverId: string;
          serverName: string;
          joinedAt?: string | null;
          roles?: { id: string; name: string }[];
        }>(raw, ['servers']);
        if (serverList.length === 0) {
          process.stdout.write(colors.dim('  No server memberships found.\n'));
        } else {
          for (const s of serverList) {
            process.stdout.write(
              `  ${colors.cyan('●')} ${colors.bold(s.serverName || s.serverId)}\n`,
            );
            if (s.joinedAt) {
              process.stdout.write(
                `    Joined: ${formatDate(s.joinedAt)} (${formatAge(s.joinedAt)})\n`,
              );
            }
            const rolesStr =
              s.roles && s.roles.length > 0
                ? s.roles.map((r) => r.name).join(', ')
                : colors.dim('none');
            process.stdout.write(`    Roles:  ${rolesStr}\n`);
          }
        }
        process.stdout.write('\n');
      } catch (err) {
        exitWithError('member get', err);
      }
    });

  // member permissions <member> [--server <s>]
  memberCmd
    .command('permissions <member>')
    .description('Show resolved permissions for a member on a server')
    .option('--server <server>', 'Server to evaluate (defaults to main server)')
    .option('--api-key <key>', 'Project API key with check_permissions scope')
    .option('--project <project>', 'Project whose API key to use')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (
        memberArg: string,
        options: {
          server?: string;
          apiKey?: string;
          project?: string;
          profile?: string;
          json?: boolean;
        },
      ) => {
        try {
          const keyInfo = await resolveProjectKey(options.apiKey, options.profile, options.project);
          const config = await loadConfig(configPath());
          const profileName = resolveProfileName(config, options.profile);
          const baseUrl =
            keyInfo.baseUrl ||
            normalizeBaseUrl(
              process.env.MCID_API_URL ||
                config.profiles[profileName]?.baseUrl ||
                'http://localhost:3000',
            );
          const snowflake = /^\d{17,20}$/;
          const explicitServer = options.server;
          let resolvedServer: { id: string; name: string };
          let resolvedMember: { discordId: string; username: string };

          if (explicitServer && snowflake.test(explicitServer) && snowflake.test(memberArg)) {
            // Project API keys cannot enumerate admin resources. Accept explicit
            // snowflakes so project-only callers do not need an admin session.
            resolvedServer = { id: explicitServer, name: explicitServer };
            resolvedMember = { discordId: memberArg, username: memberArg };
          } else {
            const client = await getClient(options.profile);
            resolvedServer = await resolveServer(client, options.server);
            resolvedMember = await resolveMember(client, memberArg);
          }

          const permissionsUrl = `${baseUrl}/api/permissions/${encodeURIComponent(resolvedServer.id)}/${encodeURIComponent(resolvedMember.discordId)}`;
          const response = await fetch(permissionsUrl, {
            headers: {
              Accept: 'application/json',
              'X-API-Key': keyInfo.apiKey,
            },
            signal: AbortSignal.timeout(15_000),
          });
          const raw = await response.json().catch(() => null);

          if (!response.ok) {
            const message =
              (raw as { message?: string } | null)?.message || `HTTP ${response.status}`;
            throw new CliError(
              `Permission check failed: ${message}\n  hint: the project key needs the check_permissions scope for this server`,
              response.status === 401 || response.status === 403
                ? ExitCode.Auth
                : ExitCode.Rejected,
            );
          }

          if (options.json) {
            printJson(raw);
            return;
          }

          const data = raw as {
            permissions?: (string | { name?: string; code?: string })[];
            sources?: {
              global?: string[];
              server?: string[];
              hierarchy?: string[];
              inherited?: string[];
            };
          };
          const list = (data.permissions || []).map((permission) =>
            typeof permission === 'string'
              ? { code: permission, source: sourceOf(permission, data.sources) }
              : {
                  code: permission.code || permission.name || '-',
                  source: sourceOf(permission.code || permission.name || '', data.sources),
                },
          );

          process.stdout.write(
            `Resolved permissions for ${colors.bold(`@${resolvedMember.username}`)} on ${colors.bold(resolvedServer.name)}:\n\n`,
          );

          if (list.length === 0) {
            process.stdout.write(colors.dim('No permissions assigned.\n'));
            return;
          }

          printTable({
            columns: [
              {
                header: 'PERMISSION',
                key: 'code',
                format: (v) => colors.bold(String(v)),
              },
              { header: 'SOURCE', key: 'source' },
            ],
            data: list,
          });
        } catch (err) {
          exitWithError('member permissions', err);
        }
      },
    );

  // member export
  memberCmd
    .command('export')
    .description('Export members to a CSV or JSON file')
    .option('--server <server>', 'Server to export (defaults to main server)')
    .option('--role <role...>', 'Filter by role ID')
    .option('-o, --output <format>', 'Export format (csv|json)', 'csv')
    .option('--file <path>', 'Destination file path')
    .option('--profile <name>', 'Profile to use')
    .action(
      async (options: {
        server?: string;
        role?: string[];
        output?: 'csv' | 'json';
        file?: string;
        profile?: string;
      }) => {
        try {
          const client = await getClient(options.profile);
          const resolvedServer = await resolveServer(client, options.server);

          const format = options.output || 'csv';
          const params = new URLSearchParams({
            serverId: resolvedServer.id,
            format,
          });
          if (options.role && options.role.length > 0) {
            for (const r of options.role) params.append('roleId', r);
          }

          const data = await client.get<Record<string, unknown>[] | string>(
            `/admin/members/export?${params.toString()}`,
          );

          const content =
            typeof data === 'string'
              ? data
              : format === 'json'
                ? JSON.stringify(data, null, 2)
                : toCsv(data);
          const defaultFilename = `members-${resolvedServer.id}-${new Date().toISOString().slice(0, 10)}.${format}`;
          const targetFile = options.file || defaultFilename;

          await writeFile(targetFile, content, { encoding: 'utf8', mode: 0o600 });
          const count = typeof data === 'string' ? undefined : data.length;
          printSuccess(
            `Exported ${count !== undefined ? `${count} member row(s)` : 'members'} to ${targetFile}`,
          );
        } catch (err) {
          exitWithError('member export', err);
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
