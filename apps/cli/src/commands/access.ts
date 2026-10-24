import { Command } from 'commander';
import { ACCESS_LEVELS, isAccessLevel, isAccessResource } from '@mcid/contracts';
import { configPath, loadConfig, resolveProfileName } from '../config.js';
import { defaultKeyProvider } from '../crypto-store.js';
import { CliError, ExitCode, exitWithError } from '../errors.js';
import { confirmAction } from '../lib/confirm.js';
import {
  normalizeAccessCatalog,
  normalizeAccessOverrides,
  normalizeAccessRoles,
} from '../lib/api-normalize.js';
import { ApiClient } from '../lib/client.js';
import { printJson, printKeyValue, printSuccess, printTable } from '../lib/output.js';
import { resolveMember } from '../lib/resolver.js';
import { colors } from '../lib/tui.js';
import { resolveSession } from '../session.js';

interface EffectiveAccessResponse {
  memberId: string;
  username: string;
  displayName?: string | null;
  root: boolean;
  access: Record<
    string,
    {
      level: string;
      source?: {
        type: 'root' | 'override' | 'role';
        roleId?: string;
        roleName?: string;
      };
    }
  >;
}

export function registerAccessCommand(program: Command): void {
  const accessCmd = program
    .command('access')
    .description('Inspect and manage admin access levels and role grants');

  // access catalog
  accessCmd
    .command('catalog')
    .description('List valid admin resources and access levels')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const raw = await client.get('/admin/access/catalog');
        const catalog = normalizeAccessCatalog(raw);

        if (options.json) {
          printJson(raw);
          return;
        }

        const label = (item: { key: string; description?: string | undefined }) =>
          item.description ? `${item.key} — ${item.description}` : item.key;

        process.stdout.write(`${colors.bold('Admin Access Catalog')}\n\n`);
        process.stdout.write(`${colors.bold('Levels')} (ordered none < read < write < manage):\n`);
        for (const l of catalog.levels) {
          process.stdout.write(`  - ${label(l)}\n`);
        }
        process.stdout.write(`\n${colors.bold('Resources')}:\n`);
        for (const r of catalog.resources) {
          process.stdout.write(`  - ${label(r)}\n`);
        }
      } catch (err) {
        exitWithError('access catalog', err);
      }
    });

  // access explain <member>
  accessCmd
    .command('explain <member>')
    .description('Explain effective admin access levels and their sources for a member')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (memberArg: string, options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveMember(client, memberArg);
        const effective = await client.get<EffectiveAccessResponse>(
          `/admin/access/members/${encodeURIComponent(resolved.discordId)}/effective`,
        );
        const roleNames = new Map<string, string>();
        try {
          for (const role of normalizeAccessRoles(await client.get('/admin/access/roles'))) {
            roleNames.set(role.id, role.name);
          }
        } catch {
          // Role names are cosmetic; the API's role id is still useful.
        }

        if (options.json) {
          printJson(effective);
          return;
        }

        process.stdout.write(
          `Effective admin access for ${colors.bold(`@${effective.username}`)} (${colors.dim(effective.memberId)}):\n\n`,
        );

        if (effective.root) {
          process.stdout.write(
            `  ${colors.magenta('ROOT ADMIN')} — Holds root management role (all resources = manage)\n\n`,
          );
        }

        const entries = Object.entries(effective.access || {});
        const tableData = entries.map(([resource, info]) => {
          let sourceText = 'default';
          if (effective.root) {
            sourceText = 'root (MC_EXECUTIVE_ROLE_ID)';
          } else if (info.source) {
            if (info.source.type === 'role') {
              const roleId = info.source.roleId;
              const roleName = info.source.roleName ?? (roleId ? roleNames.get(roleId) : undefined);
              sourceText = `from role "${roleName || roleId || 'role'}"`;
            } else if (info.source.type === 'override') {
              sourceText = 'member override';
            }
          }

          let formattedLevel: string = info.level;
          if (info.level === 'manage') formattedLevel = colors.magenta('manage');
          else if (info.level === 'write') formattedLevel = colors.green('write');
          else if (info.level === 'read') formattedLevel = colors.cyan('read');
          else formattedLevel = colors.dim('none');

          return {
            resource,
            level: formattedLevel,
            source: sourceText,
          };
        });

        printTable({
          columns: [
            { header: 'RESOURCE', key: 'resource', format: (v) => colors.bold(String(v)) },
            { header: 'LEVEL', key: 'level' },
            { header: 'SOURCE', key: 'source', format: (v) => colors.dim(String(v)) },
          ],
          data: tableData as unknown as Record<string, unknown>[],
        });
      } catch (err) {
        exitWithError('access explain', err);
      }
    });

  // access roles
  accessCmd
    .command('roles')
    .description('View main-server roles with their admin access grants')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const raw = await client.get('/admin/access/roles');

        if (options.json) {
          printJson(raw);
          return;
        }

        const roles = normalizeAccessRoles(raw);

        printTable({
          columns: [
            { header: 'ROLE', key: 'name', format: (v) => colors.bold(String(v)) },
            { header: 'ROLE ID', key: 'id', format: (v) => colors.dim(String(v)) },
            {
              header: 'GRANTS',
              format: (_, r) => {
                const g = r['grants'] as Record<string, string> | undefined;
                if (!g || Object.keys(g).length === 0) return colors.dim('none');
                return Object.entries(g)
                  .filter(([, lvl]) => lvl !== 'none')
                  .map(([res, lvl]) => `${res}:${lvl}`)
                  .join(', ');
              },
            },
          ],
          data: roles as unknown as Record<string, unknown>[],
        });
      } catch (err) {
        exitWithError('access roles', err);
      }
    });

  // access role set <role> <resource=level...> (real nested subcommands;
  // a space alias can never match since commander compares one argv token)
  const roleCmd = accessCmd.command('role').description('Manage role grants');
  const accessRoleSetOptions = (cmd: Command) =>
    cmd
      .option('--replace', 'Replace all grants instead of merging')
      .option('--yes', 'Skip confirmation prompt')
      .option('--profile <name>', 'Profile to use');
  const roleSetAction = async (
    roleArg: string,
    grantPairs: string[],
    options: { replace?: boolean; yes?: boolean; profile?: string },
  ): Promise<void> => {
    try {
      const client = await getClient(options.profile);
      // Access grants always target main-server roles. Use the access
      // endpoint (id + name) rather than global role statistics, which
      // cannot identify a role when several servers share a name.
      const currentRoles = normalizeAccessRoles(await client.get('/admin/access/roles'));
      const wanted = roleArg.startsWith('@') ? roleArg.slice(1) : roleArg;
      const matches = currentRoles.filter(
        (role) => role.id === wanted || role.name.toLowerCase() === wanted.toLowerCase(),
      );
      const resolvedRole = matches.find((role) => role.id === wanted) ?? matches[0];
      if (!resolvedRole) {
        throw new CliError(
          `Role "${roleArg}" not found on the main server. Run \`mcid-cli access roles\` to list roles.`,
          ExitCode.NotFound,
        );
      }
      if (!wanted.match(/^\d+$/) && matches.length > 1) {
        throw new CliError(
          `Role name "${roleArg}" is ambiguous. Specify the role ID instead.`,
          ExitCode.Usage,
        );
      }

      const newGrants: Record<string, string> = {};
      for (const pair of grantPairs) {
        const [res, lvl] = pair.split('=');
        if (!res || !lvl) {
          throw new CliError(
            `Invalid grant format "${pair}". Expected format: <resource>=<level>`,
            ExitCode.Usage,
          );
        }
        if (!isAccessResource(res)) {
          throw new CliError(
            `Unknown resource "${res}". Run \`mcid-cli access catalog\` to view valid resources.`,
            ExitCode.Usage,
          );
        }
        if (!isAccessLevel(lvl)) {
          throw new CliError(
            `Unknown access level "${lvl}". Expected one of: ${ACCESS_LEVELS.join(', ')}`,
            ExitCode.Usage,
          );
        }
        newGrants[res] = lvl;
      }

      // Merge with current grants unless --replace is passed
      let targetGrants: Record<string, string> = {};
      if (!options.replace && Object.keys(resolvedRole.grants).length > 0) {
        targetGrants = { ...resolvedRole.grants };
      }
      Object.assign(targetGrants, newGrants);

      // Show diff
      process.stdout.write(`${colors.bold(`Updating grants for role "${resolvedRole.name}":`)}\n`);
      for (const [r, l] of Object.entries(newGrants)) {
        process.stdout.write(`  ${colors.cyan('●')} ${r}: ${l}\n`);
      }

      if (
        !(await confirmAction(`Apply grant changes to role "${resolvedRole.name}"?`, options.yes))
      ) {
        return;
      }

      await client.put(`/admin/access/roles/${encodeURIComponent(resolvedRole.id)}`, {
        grants: targetGrants,
      });

      printSuccess(`Grants updated for role "${resolvedRole.name}"`);
    } catch (err) {
      exitWithError('access role set', err);
    }
  };
  accessRoleSetOptions(roleCmd.command('set <role> <grants...>'))
    .description('Update admin grants on a role (resource=level pairs)')
    .action(roleSetAction);
  accessRoleSetOptions(accessCmd.command('role-set <role> <grants...>'))
    .description('Shorthand for: access role set')
    .action(roleSetAction);

  // access member get|set|unset — nested subcommands with hyphen shorthands
  const memberCmd = accessCmd.command('member').description('Manage member access overrides');
  const accessMemberGetOptions = (cmd: Command) =>
    cmd.option('--profile <name>', 'Profile to use').option('--json', 'Output as JSON');
  const memberGetAction = async (
    memberArg: string,
    options: { profile?: string; json?: boolean },
  ): Promise<void> => {
    try {
      const client = await getClient(options.profile);
      const resolved = await resolveMember(client, memberArg);
      const res = await client.get<{
        memberId: string;
        username?: string;
        overrides: Record<string, string>;
      }>(`/admin/access/members/${encodeURIComponent(resolved.discordId)}`);

      if (options.json) {
        printJson(res);
        return;
      }

      printKeyValue({
        Member: `@${resolved.username} (${resolved.discordId})`,
        Overrides:
          Object.keys(res.overrides || {}).length > 0
            ? Object.entries(res.overrides)
                .map(([k, v]) => `${k}:${v}`)
                .join(', ')
            : colors.dim('none'),
      });
    } catch (err) {
      exitWithError('access member get', err);
    }
  };

  accessMemberGetOptions(memberCmd.command('get <member>'))
    .description('Get member-specific access overrides')
    .action(memberGetAction);
  accessMemberGetOptions(accessCmd.command('member-get <member>'))
    .description('Shorthand for: access member get')
    .action(memberGetAction);

  // access member set <member> <resource=level...>
  const accessMemberSetOptions = (cmd: Command) =>
    cmd
      .option('--replace', 'Replace all overrides instead of merging')
      .option('--yes', 'Skip confirmation prompt')
      .option('--profile <name>', 'Profile to use');
  const memberSetAction = async (
    memberArg: string,
    grantPairs: string[],
    options: { replace?: boolean; yes?: boolean; profile?: string },
  ): Promise<void> => {
    try {
      const client = await getClient(options.profile);
      const resolved = await resolveMember(client, memberArg);

      const newOverrides: Record<string, string> = {};
      for (const pair of grantPairs) {
        const [res, lvl] = pair.split('=');
        if (!res || !lvl) {
          throw new CliError(
            `Invalid format "${pair}". Expected format: <resource>=<level>`,
            ExitCode.Usage,
          );
        }
        if (!isAccessResource(res)) {
          throw new CliError(
            `Unknown resource "${res}". Run \`mcid-cli access catalog\``,
            ExitCode.Usage,
          );
        }
        if (!isAccessLevel(lvl)) {
          throw new CliError(
            `Unknown access level "${lvl}". Expected one of: ${ACCESS_LEVELS.join(', ')}`,
            ExitCode.Usage,
          );
        }
        newOverrides[res] = lvl;
      }

      let targetOverrides: Record<string, string> = {};
      if (!options.replace) {
        const current = await client.get<{ overrides: Record<string, string> }>(
          `/admin/access/members/${encodeURIComponent(resolved.discordId)}`,
        );
        targetOverrides = { ...(current.overrides || {}) };
      }
      Object.assign(targetOverrides, newOverrides);

      process.stdout.write(
        `${colors.bold(`Setting overrides for member @${resolved.username}:`)}\n`,
      );
      for (const [r, l] of Object.entries(newOverrides)) {
        process.stdout.write(`  ${colors.cyan('●')} ${r}: ${l}\n`);
      }

      if (!(await confirmAction(`Apply overrides to member @${resolved.username}?`, options.yes))) {
        return;
      }

      await client.put(`/admin/access/members/${encodeURIComponent(resolved.discordId)}`, {
        grants: targetOverrides,
      });

      printSuccess(`Overrides updated for member @${resolved.username}`);
    } catch (err) {
      exitWithError('access member set', err);
    }
  };

  accessMemberSetOptions(memberCmd.command('set <member> <grants...>'))
    .description('Set member-specific access overrides')
    .action(memberSetAction);
  accessMemberSetOptions(accessCmd.command('member-set <member> <grants...>'))
    .description('Shorthand for: access member set')
    .action(memberSetAction);

  // access member unset <member> <resource>
  const accessMemberUnsetOptions = (cmd: Command) =>
    cmd.option('--yes', 'Skip confirmation prompt').option('--profile <name>', 'Profile to use');
  const memberUnsetAction = async (
    memberArg: string,
    resource: string,
    options: { yes?: boolean; profile?: string },
  ): Promise<void> => {
    try {
      const client = await getClient(options.profile);
      const resolved = await resolveMember(client, memberArg);

      if (
        !(await confirmAction(
          `Remove override for "${resource}" from member @${resolved.username}?`,
          options.yes,
        ))
      ) {
        return;
      }

      await client.delete(
        `/admin/access/members/${encodeURIComponent(resolved.discordId)}/${encodeURIComponent(resource)}`,
      );

      printSuccess(`Removed override for "${resource}" from @${resolved.username}`);
    } catch (err) {
      exitWithError('access member unset', err);
    }
  };

  accessMemberUnsetOptions(memberCmd.command('unset <member> <resource>'))
    .description('Delete a member-specific access override')
    .action(memberUnsetAction);
  accessMemberUnsetOptions(accessCmd.command('member-unset <member> <resource>'))
    .description('Shorthand for: access member unset')
    .action(memberUnsetAction);

  // access overrides
  accessCmd
    .command('overrides')
    .description('List all members with active access overrides')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const raw = await client.get('/admin/access/overrides');

        if (options.json) {
          printJson(raw);
          return;
        }

        const overrides = normalizeAccessOverrides(raw);

        printTable({
          columns: [
            {
              header: 'MEMBER',
              format: (_, r) => colors.bold(`@${r['username'] || r['memberId']}`),
            },
            { header: 'DISCORD ID', key: 'memberId', format: (v) => colors.dim(String(v)) },
            { header: 'RESOURCE', key: 'resource' },
            { header: 'OVERRIDE LEVEL', key: 'level', format: (v) => colors.yellow(String(v)) },
          ],
          data: overrides as unknown as Record<string, unknown>[],
        });
      } catch (err) {
        exitWithError('access overrides', err);
      }
    });
}

async function getClient(profileFlag?: string): Promise<ApiClient> {
  const config = await loadConfig(configPath());
  const profileName = resolveProfileName(config, profileFlag);
  const session = await resolveSession(config, profileName, defaultKeyProvider());
  return new ApiClient(session);
}
