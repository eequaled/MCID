import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { configPath, loadConfig, resolveProfileName } from '../config.js';
import { defaultKeyProvider } from '../crypto-store.js';
import { CliError, ExitCode, exitWithError } from '../errors.js';
import {
  isProjectKeyActive,
  normalizeAccessMatrix,
  normalizeCreatedProject,
  normalizeProjectAccessLogs,
  normalizeProjectKeyInfo,
  unwrapArray,
} from '../lib/api-normalize.js';
import { ApiClient } from '../lib/client.js';
import { confirmAction, confirmDestructive } from '../lib/confirm.js';
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
import { promptInput } from '../lib/prompts.js';
import { resolveProject, resolveServer } from '../lib/resolver.js';
import { PROJECT_OPERATIONS, PROJECT_SCOPES } from '@mcid/contracts';
import { colors } from '../lib/tui.js';
import { resolveSession } from '../session.js';

interface ProjectRecord {
  id: string;
  name: string;
  description?: string | null;
  redirectUri?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyCreatedAt?: string | null;
  isActive?: boolean;
  isKeyRevoked?: boolean;
  createdAt?: string;
  updatedAt?: string;
  serversCount?: number;
}

export function registerProjectCommand(program: Command): void {
  const projectCmd = program
    .command('project')
    .description('Manage MCID projects, API keys, redirect URIs, and server access');

  // project list / ls
  const listAction = async (options: {
    profile?: string;
    json?: boolean;
    output?: 'table' | 'json' | 'csv';
    quiet?: boolean;
  }) => {
    try {
      const client = await getClient(options.profile);
      const projects = await client.get<ProjectRecord[]>('/admin/projects', {
        resource: 'project',
      });

      if (options.quiet) {
        printQuiet(projects.map((p) => p.id));
        return;
      }

      const outFormat = options.json ? 'json' : options.output || 'table';
      if (outFormat === 'json') {
        printJson(projects);
        return;
      }
      if (outFormat === 'csv') {
        process.stdout.write(toCsv(projects as unknown as Record<string, unknown>[]));
        return;
      }

      printTable({
        columns: [
          { header: 'ID', key: 'id', format: (v) => colors.dim(String(v)) },
          { header: 'NAME', key: 'name', format: (v) => colors.bold(String(v)) },
          {
            header: 'KEY STATUS',
            format: (_, r) =>
              isProjectKeyActive(r as unknown as ProjectRecord)
                ? colors.green('active')
                : colors.red('revoked'),
          },
          {
            header: 'REDIRECT URIS',
            format: (_, r) => {
              const rUri = r['redirectUri'];
              const uris = typeof rUri === 'string' ? rUri.split(',').filter(Boolean) : [];
              return uris.length > 0 ? `${uris.length} URI(s)` : colors.dim('none');
            },
          },
          { header: 'AGE', key: 'createdAt', format: (v) => colors.dim(formatAge(v as string)) },
        ],
        data: projects as unknown as Record<string, unknown>[],
      });
    } catch (err) {
      exitWithError('project list', err);
    }
  };

  projectCmd
    .command('list')
    .alias('ls')
    .description('List all projects')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as raw JSON')
    .option('-o, --output <format>', 'Output format (table|json|csv)', 'table')
    .option('-q, --quiet', 'Only print project IDs')
    .action(listAction);

  // project get <project>
  projectCmd
    .command('get <project>')
    .description('Get project details')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as raw JSON')
    .action(async (projectIdOrName: string, options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);
        const project = await client.get<ProjectRecord>(`/admin/projects/${resolved.id}`, {
          resource: 'project',
          id: resolved.id,
        });

        // Also get granted servers
        let servers: { serverId: string; scopes: string[] }[] = [];
        try {
          servers = await client.get(`/admin/projects/${resolved.id}/servers`);
        } catch {
          // ignore if secondary call fails
        }

        if (options.json) {
          printJson({ ...project, servers });
          return;
        }

        const uris = project.redirectUri ? project.redirectUri.split(',').filter(Boolean) : [];
        printKeyValue({
          ID: project.id,
          Name: project.name,
          Description: project.description || '-',
          'Key Prefix': project.apiKeyPrefix ? `${project.apiKeyPrefix}...` : '-',
          'Key Status': isProjectKeyActive(project)
            ? colors.green('active')
            : colors.red('revoked'),
          'Redirect URIs': uris.length > 0 ? uris.join(', ') : colors.dim('none'),
          'Granted Servers':
            servers.length > 0
              ? servers.map((s) => `${s.serverId} (${s.scopes.join(', ')})`).join(', ')
              : colors.dim('none'),
          Created: formatDate(project.createdAt),
          Updated: formatDate(project.updatedAt),
        });
      } catch (err) {
        exitWithError('project get', err);
      }
    });

  // project create
  projectCmd
    .command('create')
    .description('Create a new project and generate an API key')
    .option('--name <name>', 'Project name')
    .option('--description <desc>', 'Project description')
    .option('--redirect-uri <urls...>', 'Allowed redirect URI(s)')
    .option('--env-file <path>', 'Write .env block to file')
    .option('--force', 'Overwrite existing MCID_API_KEY in env file')
    .option('--reveal', 'Include the full API key in JSON output')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as raw JSON')
    .action(
      async (options: {
        name?: string;
        description?: string;
        redirectUri?: string[];
        envFile?: string;
        force?: boolean;
        reveal?: boolean;
        profile?: string;
        json?: boolean;
      }) => {
        try {
          const client = await getClient(options.profile);

          let name = options.name;
          let redirectUris = options.redirectUri;

          // Interactive wizard when flags omitted and TTY
          if (!name && process.stdin.isTTY) {
            name = await promptInput({
              message: 'Project name',
              validate: (v) => (v.length > 0 ? true : 'Name cannot be empty'),
            });

            const defaultUri = 'http://localhost:3000/callback';
            const enteredUri = await promptInput({
              message: 'Primary OAuth redirect URI',
              default: defaultUri,
            });
            redirectUris = [enteredUri || defaultUri];
          }

          if (!name) {
            throw new CliError('Project name is required (--name <name>)', ExitCode.Usage);
          }

          const commaUris = redirectUris ? redirectUris.join(',') : undefined;
          let redirectUriError: string | undefined;
          // The API returns `{ apiKey, project }`, not a flattened project.
          const res = normalizeCreatedProject<ProjectRecord>(
            await client.post('/admin/projects', {
              name,
              description: options.description,
            }),
          );
          const project = res.project;

          if (commaUris) {
            try {
              await client.patch(`/admin/projects/${project.id}/redirect-uri`, {
                redirectUri: commaUris,
              });
            } catch (err) {
              redirectUriError = err instanceof Error ? err.message : String(err);
            }
            if (!redirectUriError) project.redirectUri = commaUris;
          }

          if (options.json) {
            // The key is unrecoverable after this; masking it here would lose
            // the only copy, so --json always includes it in full.
            printJson(res, true);
            return;
          }

          printSuccess(
            `Project "${colors.bold(project.name)}" created (id: ${project.id})`,
            `mcid-cli project key show ${project.id}`,
          );

          if (redirectUriError) {
            process.stderr.write(
              `${colors.red('!')} Project was created, but redirect URI setup failed: ${redirectUriError}\n` +
                `  hint: save the API key below, then retry with \`mcid-cli project redirect-uri add ${project.id} <url>\`\n`,
            );
          }

          process.stdout.write('\n');
          process.stdout.write(
            `${colors.bold('API Key')} (save this now; it will not be shown again):\n`,
          );
          process.stdout.write(`  ${colors.green(res.apiKey)}\n\n`);

          const primaryUri =
            redirectUris && redirectUris[0] ? redirectUris[0] : 'http://localhost:3000/callback';
          const envBlock = [
            `MCID_API_URL=${client.origin}/api`,
            `MCID_API_KEY=${res.apiKey}`,
            `MCID_REDIRECT_URI=${primaryUri}`,
          ].join('\n');

          if (options.envFile) {
            let existing = '';
            try {
              existing = await readFile(options.envFile, 'utf8');
            } catch {
              // file doesn't exist
            }

            const hasApiKey = /^\s*MCID_API_KEY\s*=/m.test(existing);
            if (hasApiKey && !options.force) {
              throw new CliError(
                `File "${options.envFile}" already contains MCID_API_KEY\n  hint: pass --force to overwrite`,
                ExitCode.Rejected,
              );
            }

            const newContent = hasApiKey
              ? `${existing.replace(/^\s*MCID_API_KEY\s*=.*$/m, `MCID_API_KEY=${res.apiKey}`).trimEnd()}\n`
              : existing
                ? `${existing.trimEnd()}\n\n${envBlock}\n`
                : `${envBlock}\n`;
            await writeFile(options.envFile, newContent, { encoding: 'utf8', mode: 0o600 });
            printSuccess(`Saved environment configuration to ${options.envFile}`);
          } else {
            process.stdout.write(`${colors.dim('.env configuration block:')}\n`);
            process.stdout.write(`${envBlock}\n`);
          }
        } catch (err) {
          exitWithError('project create', err);
        }
      },
    );

  // project update <project>
  projectCmd
    .command('update <project>')
    .description('Update project details')
    .option('--name <name>', 'New project name')
    .option('--description <desc>', 'New description')
    .option('--profile <name>', 'Profile to use')
    .action(
      async (
        projectIdOrName: string,
        options: {
          name?: string;
          description?: string;
          profile?: string;
        },
      ) => {
        try {
          const client = await getClient(options.profile);
          const resolved = await resolveProject(client, projectIdOrName);
          await client.patch(`/admin/projects/${resolved.id}`, {
            name: options.name,
            description: options.description,
          });
          printSuccess(`Project "${resolved.name}" updated`);
        } catch (err) {
          exitWithError('project update', err);
        }
      },
    );

  // project delete <project>
  projectCmd
    .command('delete <project>')
    .alias('rm')
    .description('Delete a project')
    .option('--yes', 'Skip confirmation prompt')
    .option('--profile <name>', 'Profile to use')
    .action(async (projectIdOrName: string, options: { yes?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);
        await confirmDestructive({
          resourceType: 'project',
          resourceName: resolved.name,
          yesFlag: options.yes,
        });
        await client.delete(`/admin/projects/${resolved.id}`);
        printSuccess(`Project "${resolved.name}" deleted`);
      } catch (err) {
        exitWithError('project delete', err);
      }
    });

  // project redirect-uri group
  const redirectUriCmd = projectCmd
    .command('redirect-uri')
    .description('Manage allowed OAuth redirect URIs');

  redirectUriCmd
    .command('list <project>')
    .description('List allowed redirect URIs for a project')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (projectIdOrName: string, options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);
        const project = await client.get<ProjectRecord>(`/admin/projects/${resolved.id}`);
        const uris = project.redirectUri ? project.redirectUri.split(',').filter(Boolean) : [];

        if (options.json) {
          printJson(uris);
          return;
        }

        if (uris.length === 0) {
          process.stdout.write(colors.dim('No redirect URIs configured.\n'));
          return;
        }
        for (const uri of uris) {
          process.stdout.write(`- ${uri}\n`);
        }
      } catch (err) {
        exitWithError('project redirect-uri list', err);
      }
    });

  redirectUriCmd
    .command('add <project> <url>')
    .description('Add an allowed redirect URI without removing existing ones')
    .option('--profile <name>', 'Profile to use')
    .action(async (projectIdOrName: string, url: string, options: { profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);
        const project = await client.get<ProjectRecord>(`/admin/projects/${resolved.id}`);
        const currentUris = project.redirectUri
          ? project.redirectUri.split(',').filter(Boolean)
          : [];

        if (!currentUris.includes(url)) {
          currentUris.push(url);
          await client.patch(`/admin/projects/${resolved.id}/redirect-uri`, {
            redirectUri: currentUris.join(','),
          });
        }
        printSuccess(`Added redirect URI "${url}" to project "${resolved.name}"`);
      } catch (err) {
        exitWithError('project redirect-uri add', err);
      }
    });

  redirectUriCmd
    .command('remove <project> <url>')
    .description('Remove an allowed redirect URI')
    .option('--profile <name>', 'Profile to use')
    .action(async (projectIdOrName: string, url: string, options: { profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);
        const project = await client.get<ProjectRecord>(`/admin/projects/${resolved.id}`);
        const currentUris = project.redirectUri
          ? project.redirectUri.split(',').filter(Boolean)
          : [];
        const nextUris = currentUris.filter((u) => u !== url);

        await client.patch(`/admin/projects/${resolved.id}/redirect-uri`, {
          redirectUri: nextUris.join(','),
        });
        printSuccess(`Removed redirect URI "${url}" from project "${resolved.name}"`);
      } catch (err) {
        exitWithError('project redirect-uri remove', err);
      }
    });

  // project key group
  const keyCmd = projectCmd.command('key').description('Manage project API keys');

  keyCmd
    .command('show <project>')
    .description('Show project API key status and prefix')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (projectIdOrName: string, options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);
        const rawKeyInfo = await client.get(`/admin/projects/${resolved.id}/api-key`);

        if (options.json) {
          printJson(rawKeyInfo);
          return;
        }

        const keyInfo = normalizeProjectKeyInfo(rawKeyInfo);
        printKeyValue({
          Project: resolved.name,
          Status: keyInfo.active ? colors.green('active') : colors.red('revoked'),
          Prefix: `${keyInfo.prefix}...`,
          Created: formatDate(keyInfo.createdAt),
        });
      } catch (err) {
        exitWithError('project key show', err);
      }
    });

  keyCmd
    .command('rotate <project>')
    .description('Rotate the API key for a project (invalidates previous key immediately)')
    .option('--yes', 'Skip confirmation')
    .option('--profile <name>', 'Profile to use')
    .action(async (projectIdOrName: string, options: { yes?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);

        await confirmDestructive({
          resourceType: 'API key for project',
          resourceName: resolved.name,
          action: 'rotate',
          yesFlag: options.yes,
        });

        const res = await client.post<{ apiKey: string }>(
          `/admin/projects/${resolved.id}/regenerate-api-key`,
        );
        printSuccess(`API key rotated for project "${resolved.name}"`);
        process.stdout.write(`\nNew API Key: ${colors.green(res.apiKey)}\n`);
        process.stdout.write(colors.dim('Save this now; it cannot be retrieved again.\n'));
      } catch (err) {
        exitWithError('project key rotate', err);
      }
    });

  keyCmd
    .command('revoke <project>')
    .description('Revoke the API key for a project')
    .option('--yes', 'Skip confirmation')
    .option('--profile <name>', 'Profile to use')
    .action(async (projectIdOrName: string, options: { yes?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);

        await confirmDestructive({
          resourceType: 'API key for project',
          resourceName: resolved.name,
          action: 'revoke',
          yesFlag: options.yes,
        });

        await client.delete(`/admin/projects/${resolved.id}/key`);
        printSuccess(`API key revoked for project "${resolved.name}"`);
      } catch (err) {
        exitWithError('project key revoke', err);
      }
    });

  keyCmd
    .command('restore <project>')
    .description('Restore a revoked API key')
    .option('--yes', 'Skip confirmation')
    .option('--profile <name>', 'Profile to use')
    .action(async (projectIdOrName: string, options: { yes?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);

        await confirmAction(`Restore API key for project "${resolved.name}"?`, options.yes);

        await client.post(`/admin/projects/${resolved.id}/restore-key`);
        printSuccess(`API key restored for project "${resolved.name}"`);
      } catch (err) {
        exitWithError('project key restore', err);
      }
    });

  // project access group
  const accessCmd = projectCmd
    .command('access')
    .description('Manage project server access and permissions');

  accessCmd
    .command('list <project>')
    .description('List servers granted to a project')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (projectIdOrName: string, options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveProject(client, projectIdOrName);
        const servers = await client.get<
          { serverId: string; scopes: string[]; operations?: Record<string, boolean> }[]
        >(`/admin/projects/${resolved.id}/servers`);

        if (options.json) {
          printJson(servers);
          return;
        }

        printTable({
          columns: [
            { header: 'SERVER ID', key: 'serverId', format: (v) => colors.dim(String(v)) },
            {
              header: 'SCOPES',
              key: 'scopes',
              format: (v) => (Array.isArray(v) ? v.join(', ') : '-'),
            },
            {
              header: 'OPERATIONS',
              format: (_, r) => {
                if (!r.operations) return colors.dim('defaults');
                return (
                  Object.entries(r.operations)
                    .filter(([, active]) => active)
                    .map(([op]) => op)
                    .join(', ') || colors.dim('none')
                );
              },
            },
          ],
          data: servers as unknown as Record<string, unknown>[],
        });
      } catch (err) {
        exitWithError('project access list', err);
      }
    });

  accessCmd
    .command('grant <project> <server>')
    .description('Grant project access to a Discord server with scopes and operations')
    .requiredOption('--scope <scopes...>', 'Scopes to grant (read_members, check_permissions)')
    .option('--operation <ops...>', 'Operations to allow (READ, SEND_MESSAGES, MANAGE_WEBHOOKS)')
    .option('--profile <name>', 'Profile to use')
    .action(
      async (
        projectIdOrName: string,
        serverIdOrName: string,
        options: { scope: string[]; operation?: string[]; profile?: string },
      ) => {
        try {
          const client = await getClient(options.profile);
          const resolvedProject = await resolveProject(client, projectIdOrName);
          const resolvedServer = await resolveServer(client, serverIdOrName);

          // Validate against the shared contract before any request.
          for (const scope of options.scope) {
            if (!(PROJECT_SCOPES as readonly string[]).includes(scope)) {
              throw new CliError(
                `Unknown scope "${scope}". Expected one of: ${PROJECT_SCOPES.join(', ')}`,
                ExitCode.Usage,
              );
            }
          }
          const requestedOps = (options.operation ?? []).map((op) => op.toUpperCase());
          for (const op of requestedOps) {
            if (!(PROJECT_OPERATIONS as readonly string[]).includes(op)) {
              throw new CliError(
                `Unknown operation "${op}". Expected one of: ${PROJECT_OPERATIONS.join(', ')}`,
                ExitCode.Usage,
              );
            }
          }

          // The PUT replaces the grant and fills omitted operations with
          // defaults server-side: read the current grant first so omitting
          // --operation keeps what is already there.
          let operations: Record<string, boolean> | undefined;
          if (requestedOps.length === 0) {
            const grants = await client.get<
              { serverId: string; operations?: Record<string, boolean> }[]
            >(`/admin/projects/${resolvedProject.id}/servers`);
            const existing = grants.find((g) => g.serverId === resolvedServer.id);
            operations = existing?.operations;
          } else {
            // Explicit list = intentional replace, with every operation named
            // so turning one off (e.g. READ) is expressible.
            operations = Object.fromEntries(
              PROJECT_OPERATIONS.map((op) => [op, requestedOps.includes(op)]),
            );
          }

          await client.put(`/admin/projects/${resolvedProject.id}/servers/${resolvedServer.id}`, {
            scopes: options.scope,
            ...(operations !== undefined ? { operations } : {}),
          });

          printSuccess(
            `Granted access for project "${resolvedProject.name}" on server "${resolvedServer.name}"`,
          );
        } catch (err) {
          exitWithError('project access grant', err);
        }
      },
    );

  accessCmd
    .command('revoke <project> <server>')
    .description('Revoke project access to a Discord server')
    .option('--yes', 'Skip confirmation')
    .option('--profile <name>', 'Profile to use')
    .action(
      async (
        projectIdOrName: string,
        serverIdOrName: string,
        options: { yes?: boolean; profile?: string },
      ) => {
        try {
          const client = await getClient(options.profile);
          const resolvedProject = await resolveProject(client, projectIdOrName);
          const resolvedServer = await resolveServer(client, serverIdOrName);

          await confirmDestructive({
            resourceType: 'project access grant on server',
            resourceName: `${resolvedProject.name} / ${resolvedServer.name}`,
            action: 'revoke',
            yesFlag: options.yes,
          });

          await client.delete(`/admin/projects/${resolvedProject.id}/servers/${resolvedServer.id}`);
          printSuccess(
            `Revoked access for project "${resolvedProject.name}" on server "${resolvedServer.name}"`,
          );
        } catch (err) {
          exitWithError('project access revoke', err);
        }
      },
    );

  accessCmd
    .command('matrix')
    .description('View project-to-server access matrix')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const raw = await client.get('/admin/projects/access/matrix');
        if (options.json) {
          printJson(raw);
          return;
        }

        printTable({
          columns: [
            {
              header: 'PROJECT',
              key: 'projectName',
              format: (v) => colors.bold(String(v)),
            },
            { header: 'SERVER', key: 'serverName' },
            {
              header: 'SCOPES',
              key: 'scopes',
              format: (v) => (Array.isArray(v) ? v.join(', ') : colors.dim('-')),
            },
            {
              header: 'OPERATIONS',
              key: 'operations',
              format: (v) => {
                if (!v || typeof v !== 'object') return colors.dim('none');
                return (
                  Object.entries(v as Record<string, boolean>)
                    .filter(([, active]) => active)
                    .map(([op]) => op)
                    .join(', ') || colors.dim('none')
                );
              },
            },
          ],
          data: normalizeAccessMatrix(raw) as unknown as Record<string, unknown>[],
        });
      } catch (err) {
        exitWithError('project access matrix', err);
      }
    });

  accessCmd
    .command('log')
    .description('View project access audit logs')
    .option('--project <project>', 'Filter by project')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { project?: string; profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        let path = '/admin/projects/access/audit';
        if (options.project) {
          const p = await resolveProject(client, options.project);
          path += `?projectId=${encodeURIComponent(p.id)}`;
        }
        const raw = await client.get(path);
        if (options.json) {
          printJson(raw);
          return;
        }

        const projectNames = new Map<string, string>();
        const serverNames = new Map<string, string>();
        try {
          const projects = await client.get<{ id: string; name: string }[]>('/admin/projects');
          for (const project of projects) projectNames.set(project.id, project.name);
          const servers = unwrapArray<{ id: string; name: string }>(await client.get('/servers'), [
            'servers',
            'data',
          ]);
          for (const server of servers) serverNames.set(server.id, server.name);
        } catch {
          // Names are cosmetic; IDs still identify the rows.
        }

        const logs = normalizeProjectAccessLogs(raw);
        printTable({
          columns: [
            { header: 'TIME', key: 'timestamp', format: (v) => formatAge(String(v)) },
            { header: 'ACTION', key: 'action', format: (v) => colors.bold(String(v)) },
            { header: 'ACTOR', key: 'actor', format: (v) => colors.dim(String(v)) },
            {
              header: 'PROJECT',
              key: 'projectId',
              format: (v) => projectNames.get(String(v)) ?? colors.dim(String(v)),
            },
            {
              header: 'SERVER',
              key: 'serverId',
              format: (v) => serverNames.get(String(v)) ?? colors.dim(String(v)),
            },
          ],
          data: logs as unknown as Record<string, unknown>[],
        });
      } catch (err) {
        exitWithError('project access log', err);
      }
    });
}

async function getClient(profileFlag?: string): Promise<ApiClient> {
  const config = await loadConfig(configPath());
  const profileName = resolveProfileName(config, profileFlag);
  const session = await resolveSession(config, profileName, defaultKeyProvider());
  return new ApiClient(session);
}
