import { Command } from 'commander';
import { configPath, loadConfig, resolveProfileName } from '../config.js';
import { defaultKeyProvider } from '../crypto-store.js';
import { CliError, ExitCode, exitWithError } from '../errors.js';
import { ApiClient } from '../lib/client.js';
import { confirmDestructive } from '../lib/confirm.js';
import {
  formatAge,
  formatDate,
  printJson,
  printKeyValue,
  printQuiet,
  printSuccess,
  printTable,
  toCsv,
} from '../lib/output.js';
import { resolveServer } from '../lib/resolver.js';
import { colors } from '../lib/tui.js';
import { resolveSession } from '../session.js';

interface ServerRecord {
  id: string;
  name: string;
  isMain?: boolean;
  isActive?: boolean;
  syncFrequencyHours?: number;
  /** GET /servers: the last successful sync, from the sync log rollup. */
  lastSyncAt?: string | null;
  syncedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface ChannelRecord {
  id: string;
  name: string;
  type?: number | string;
  categoryName?: string | undefined;
  parentId?: string | null;
  position?: number;
}

/** ChannelListResponseDto: the API wraps the channels and returns categories separately. */
interface ChannelListResponse {
  channels: ChannelRecord[];
  categories: { id: string; name: string }[];
}

export function registerServerCommand(program: Command): void {
  const serverCmd = program.command('server').description('Manage Discord servers and channels');

  // server list / ls
  const listAction = async (options: {
    profile?: string;
    json?: boolean;
    output?: 'table' | 'json' | 'csv';
    quiet?: boolean;
  }) => {
    try {
      const client = await getClient(options.profile);
      const servers = await client.get<ServerRecord[]>('/servers', { resource: 'server' });

      if (options.quiet) {
        printQuiet(servers.map((s) => s.id));
        return;
      }

      const outFormat = options.json ? 'json' : options.output || 'table';
      if (outFormat === 'json') {
        printJson(servers);
        return;
      }
      if (outFormat === 'csv') {
        process.stdout.write(toCsv(servers as unknown as Record<string, unknown>[]));
        return;
      }

      printTable({
        columns: [
          { header: 'ID', key: 'id', format: (v) => colors.dim(String(v)) },
          {
            header: 'NAME',
            format: (_, r) => {
              const name = colors.bold(String(r['name'] || ''));
              return r['isMain'] ? `${name} ${colors.cyan('[main]')}` : name;
            },
          },
          {
            header: 'STATUS',
            format: (_, r) =>
              r.isActive !== false ? colors.green('active') : colors.red('disabled'),
          },
          {
            header: 'LAST SYNC',
            format: (_, r) =>
              colors.dim(
                formatAge(
                  typeof r['lastSyncAt'] === 'string'
                    ? r['lastSyncAt']
                    : typeof r['syncedAt'] === 'string'
                      ? (r['syncedAt'] as string)
                      : undefined,
                ),
              ),
          },
        ],
        data: servers as unknown as Record<string, unknown>[],
      });
    } catch (err) {
      exitWithError('server list', err);
    }
  };

  serverCmd
    .command('list')
    .alias('ls')
    .description('List all registered Discord servers')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .option('-o, --output <format>', 'Output format (table|json|csv)', 'table')
    .option('-q, --quiet', 'Only print server IDs')
    .action(listAction);

  // server get <server>
  serverCmd
    .command('get [server]')
    .description('Get server details (defaults to main server if omitted)')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (serverIdOrName: string | undefined, options: { profile?: string; json?: boolean }) => {
        try {
          const client = await getClient(options.profile);
          const resolved = await resolveServer(client, serverIdOrName);
          const server = await client.get<ServerRecord>(`/servers/${resolved.id}`, {
            resource: 'server',
            id: resolved.id,
          });

          if (options.json) {
            printJson(server);
            return;
          }

          printKeyValue({
            ID: server.id,
            Name: server.name + (server.isMain ? ' [main]' : ''),
            Status: server.isActive !== false ? colors.green('active') : colors.red('disabled'),
            'Main Server': server.isMain ? 'yes' : 'no',
            'Auto Sync': `enabled (every ${server.syncFrequencyHours ?? 1}h)`,
            'Last Synced': server.lastSyncAt
              ? `${formatDate(server.lastSyncAt)} (${formatAge(server.lastSyncAt)})`
              : server.syncedAt
                ? `${formatDate(server.syncedAt)} (${formatAge(server.syncedAt)})`
                : 'never',
            Created: formatDate(server.createdAt),
            Updated: formatDate(server.updatedAt),
          });
        } catch (err) {
          exitWithError('server get', err);
        }
      },
    );

  // server add <guild-id>
  serverCmd
    .command('add <guild-id>')
    .description('Register a new Discord server (guild) in MCID')
    .option('--name <name>', 'Server name override (defaults to the Discord guild name)')
    .option('--profile <name>', 'Profile to use')
    .action(async (guildId: string, options: { name?: string; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        // POST /servers upserts and would reset an existing row's type, sync
        // cadence, policy and enabled state — refuse instead of clobbering.
        const existing = (await client.get<ServerRecord[]>('/servers')).find(
          (s) => s.id === guildId,
        );
        if (existing) {
          throw new CliError(
            `Server "${existing.name || guildId}" (${guildId}) is already registered\n  hint: use \`mcid-cli server update ${guildId}\` to change it`,
            ExitCode.Rejected,
          );
        }

        const res = await client.post<ServerRecord>('/servers', {
          guildId,
          // Omitted when not given: the API fills the real guild name from
          // the bot cache; sending the id would name the server "1234...".
          ...(options.name ? { name: options.name } : {}),
        });
        printSuccess(`Server "${res.name}" registered (ID: ${res.id})`);
      } catch (err) {
        exitWithError('server add', err);
      }
    });

  // server update <server>
  serverCmd
    .command('update <server>')
    .description('Update server settings')
    .option('--name <name>', 'New name')
    .option('--profile <name>', 'Profile to use')
    .action(async (serverIdOrName: string, options: { name?: string; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveServer(client, serverIdOrName);
        await client.patch(`/servers/${resolved.id}`, {
          name: options.name,
        });
        printSuccess(`Server "${resolved.name}" updated`);
      } catch (err) {
        exitWithError('server update', err);
      }
    });

  // server enable <server>
  serverCmd
    .command('enable <server>')
    .description('Enable a server')
    .option('--profile <name>', 'Profile to use')
    .action(async (serverIdOrName: string, options: { profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveServer(client, serverIdOrName);
        await client.patch(`/servers/${resolved.id}/enable`);
        printSuccess(`Server "${resolved.name}" enabled`);
      } catch (err) {
        exitWithError('server enable', err);
      }
    });

  // server disable <server>
  serverCmd
    .command('disable <server>')
    .description('Disable a server')
    .option('--profile <name>', 'Profile to use')
    .action(async (serverIdOrName: string, options: { profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveServer(client, serverIdOrName);
        if (resolved.isMain) {
          throw new CliError('The main server cannot be disabled or deleted.', ExitCode.Rejected);
        }
        await client.patch(`/servers/${resolved.id}/disable`);
        printSuccess(`Server "${resolved.name}" disabled`);
      } catch (err) {
        exitWithError('server disable', err);
      }
    });

  // server delete <server>
  serverCmd
    .command('delete <server>')
    .alias('rm')
    .description('Delete a server')
    .option('--yes', 'Skip confirmation')
    .option('--profile <name>', 'Profile to use')
    .action(async (serverIdOrName: string, options: { yes?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveServer(client, serverIdOrName);
        if (resolved.isMain) {
          throw new CliError('The main server cannot be disabled or deleted.', ExitCode.Rejected);
        }
        await confirmDestructive({
          resourceType: 'server',
          resourceName: resolved.name,
          yesFlag: options.yes,
        });
        await client.delete(`/servers/${resolved.id}`);
        printSuccess(`Server "${resolved.name}" deleted`);
      } catch (err) {
        exitWithError('server delete', err);
      }
    });

  // server channels <server>
  serverCmd
    .command('channels [server]')
    .description('List channels for a server')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (serverIdOrName: string | undefined, options: { profile?: string; json?: boolean }) => {
        try {
          const client = await getClient(options.profile);
          const resolved = await resolveServer(client, serverIdOrName);
          const list = await client.get<ChannelListResponse>(
            `/admin/servers/${resolved.id}/channels`,
          );
          // No categoryName on the wire: derive it from parentId.
          const categoryNames = new Map(
            (list.categories ?? []).map((c) => [c.id, c.name] as const),
          );
          const channels: ChannelRecord[] = (list.channels ?? []).map((c) => ({
            ...c,
            categoryName: c.parentId ? categoryNames.get(c.parentId) : undefined,
          }));

          if (options.json) {
            printJson(channels);
            return;
          }

          printTable({
            columns: [
              { header: 'ID', key: 'id', format: (v) => colors.dim(String(v)) },
              { header: 'NAME', key: 'name', format: (v) => colors.bold(String(v)) },
              { header: 'CATEGORY', key: 'categoryName', format: (v) => String(v || '-') },
              { header: 'TYPE', key: 'type', format: (v) => String(v ?? '-') },
            ],
            data: channels as unknown as Record<string, unknown>[],
          });
        } catch (err) {
          exitWithError('server channels', err);
        }
      },
    );

  // server channel <server> <channel>
  serverCmd
    .command('channel [server] <channel>')
    .description('Inspect a channel and optionally view recent messages')
    .option('--messages <n>', 'Number of recent messages to fetch')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (
        serverArg: string | undefined,
        channelId: string,
        options: { messages?: string; profile?: string; json?: boolean },
      ) => {
        try {
          // Reject an out-of-range count before any request: the API 400s above 100.
          if (options.messages) {
            const count = Number(options.messages);
            if (!Number.isInteger(count) || count < 1 || count > 100) {
              throw new CliError(
                `--messages must be between 1 and 100, got "${options.messages}"`,
                ExitCode.Usage,
              );
            }
          }
          const client = await getClient(options.profile);
          const resolved = await resolveServer(client, serverArg);
          const list = await client.get<ChannelListResponse>(
            `/admin/servers/${resolved.id}/channels`,
          );
          const categoryNames = new Map(
            (list.categories ?? []).map((c) => [c.id, c.name] as const),
          );
          const raw = (list.channels ?? []).find((c) => c.id === channelId);
          if (!raw) {
            throw new CliError(
              `Channel "${channelId}" not found on server "${resolved.name}"`,
              ExitCode.NotFound,
            );
          }
          const channel: ChannelRecord = {
            ...raw,
            categoryName: raw.parentId ? categoryNames.get(raw.parentId) : undefined,
          };

          let messages: {
            id: string;
            content: string;
            author: { username: string };
            timestamp: string;
          }[] = [];
          if (options.messages) {
            const page = await client.get<{
              messages: {
                id: string;
                content: string;
                author: { username: string };
                timestamp: string;
              }[];
            }>(
              `/admin/servers/${resolved.id}/channels/${channelId}/messages?limit=${options.messages}`,
            );
            messages = page.messages ?? [];
          }

          if (options.json) {
            printJson({ channel, messages });
            return;
          }

          printKeyValue({
            ID: channel.id,
            Name: channel.name,
            Category: channel.categoryName || '-',
            Type: channel.type ?? '-',
          });

          if (messages.length > 0) {
            process.stdout.write(`\n${colors.bold('Recent Messages:')}\n`);
            for (const msg of messages) {
              const author = msg.author?.username || 'unknown';
              process.stdout.write(
                `  [${colors.dim(formatAge(msg.timestamp))}] ${colors.cyan(`@${author}`)}: ${msg.content}\n`,
              );
            }
          }
        } catch (err) {
          exitWithError('server channel', err);
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
