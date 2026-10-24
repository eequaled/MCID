import { CliError, ExitCode } from '../errors.js';
import type { ApiClient } from './client.js';

export interface ProjectEntity {
  id: string;
  name: string;
  slug?: string | undefined;
}

export interface ServerEntity {
  id: string;
  name: string;
  isMain?: boolean | undefined;
}

export interface RoleEntity {
  id: string;
  name: string;
}

export interface MemberEntity {
  id?: string | undefined;
  memberId?: string | undefined;
  discordId?: string | undefined;
  username: string;
  displayName?: string | null | undefined;
  globalName?: string | null | undefined;
}

export interface WebhookEntity {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolves a project identifier (ID, slug, or case-insensitive name) to a project.
 */
export async function resolveProject(
  client: ApiClient,
  idOrNameOrSlug: string,
): Promise<ProjectEntity> {
  const projects = await client.get<ProjectEntity[]>('/admin/projects', {
    resource: 'project',
  });

  const exactId = projects.find((p) => p.id === idOrNameOrSlug);
  if (exactId) return exactId;

  const matches = projects.filter(
    (p) =>
      p.id.toLowerCase() === idOrNameOrSlug.toLowerCase() ||
      (p.slug && p.slug.toLowerCase() === idOrNameOrSlug.toLowerCase()) ||
      p.name.toLowerCase() === idOrNameOrSlug.toLowerCase(),
  );

  const firstMatch = matches[0];
  if (matches.length === 1 && firstMatch) return firstMatch;
  if (matches.length > 1) {
    const list = matches.map((m) => `  - ${m.name} (id: ${m.id})`).join('\n');
    throw new CliError(
      `Project name "${idOrNameOrSlug}" is ambiguous, matches multiple projects:\n${list}\n  hint: specify the project ID or slug directly`,
      ExitCode.Usage,
    );
  }

  throw new CliError(
    `Project "${idOrNameOrSlug}" not found\n  hint: list available projects with \`mcid-cli project list\``,
    ExitCode.NotFound,
  );
}

/**
 * Resolves a server identifier. If none is passed, resolves to the main server.
 */
export async function resolveServer(
  client: ApiClient,
  idOrName?: string | undefined,
): Promise<ServerEntity> {
  const servers = await client.get<ServerEntity[]>('/servers', {
    resource: 'server',
  });

  if (!idOrName) {
    const main = servers.find((s) => s.isMain);
    if (!main) {
      const firstServer = servers[0];
      if (servers.length === 1 && firstServer) return firstServer;
      throw new CliError(
        'No default main server configured on this MCID instance\n  hint: specify --server <id>',
        ExitCode.NotFound,
      );
    }
    return main;
  }

  const exactId = servers.find((s) => s.id === idOrName);
  if (exactId) return exactId;

  const matches = servers.filter(
    (s) =>
      s.id.toLowerCase() === idOrName.toLowerCase() ||
      s.name.toLowerCase() === idOrName.toLowerCase(),
  );

  const firstMatch = matches[0];
  if (matches.length === 1 && firstMatch) return firstMatch;
  if (matches.length > 1) {
    const list = matches.map((m) => `  - ${m.name} (id: ${m.id})`).join('\n');
    throw new CliError(
      `Server name "${idOrName}" is ambiguous, matches multiple servers:\n${list}\n  hint: specify the server ID directly`,
      ExitCode.Usage,
    );
  }

  throw new CliError(
    `Server "${idOrName}" not found\n  hint: list available servers with \`mcid-cli server list\``,
    ExitCode.NotFound,
  );
}

/**
 * Resolves a role on a specific server by ID or case-insensitive name.
 */
export async function resolveRole(
  client: ApiClient,
  serverId: string,
  idOrName: string,
): Promise<RoleEntity> {
  // Use stats/roles which lists all roles on the server with names and counts
  const response = await client.get<
    RoleEntity[] | { roles?: { roleId?: string; roleName?: string; id?: string; name?: string }[] }
  >(`/admin/stats/roles?serverId=${encodeURIComponent(serverId)}`, {
    resource: 'role',
  });
  // Global role statistics omit `roleId`, so never assume the fields exist.
  const rawRoles = Array.isArray(response) ? response : (response.roles ?? []);
  const roles: RoleEntity[] = rawRoles
    .map((role) => {
      const r = role as { roleId?: string; roleName?: string; id?: string; name?: string };
      return {
        id: String(r.roleId ?? r.id ?? ''),
        name: String(r.roleName ?? r.name ?? ''),
      };
    })
    .filter((r) => r.id.length > 0 && r.name.length > 0);

  const exactId = roles.find((r) => r.id === idOrName);
  if (exactId) return exactId;

  const matches = roles.filter(
    (r) =>
      r.id.toLowerCase() === idOrName.toLowerCase() ||
      r.name.toLowerCase() === idOrName.toLowerCase(),
  );

  const firstMatch = matches[0];
  if (matches.length === 1 && firstMatch) return firstMatch;
  if (matches.length > 1) {
    const list = matches.map((m) => `  - ${m.name} (id: ${m.id})`).join('\n');
    throw new CliError(
      `Role name "${idOrName}" is ambiguous on this server:\n${list}\n  hint: specify the role ID directly`,
      ExitCode.Usage,
    );
  }

  throw new CliError(
    `Role "${idOrName}" not found on server ${serverId}\n  hint: list roles with \`mcid-cli role list --server ${serverId}\``,
    ExitCode.NotFound,
  );
}

/**
 * Resolves a member by Discord snowflake ID or @username.
 */
export async function resolveMember(
  client: ApiClient,
  idOrUsername: string,
): Promise<{ discordId: string; username: string }> {
  const clean = idOrUsername.startsWith('@') ? idOrUsername.slice(1) : idOrUsername;

  // If snowflake format (17-20 numeric digits), treat as ID directly
  if (/^\d{17,20}$/.test(clean)) {
    return { discordId: clean, username: clean };
  }

  // Otherwise, search members via /admin/members?search= (a full page, so a
  // member beyond the API's 20-row default is still found)
  const res = await client.get<
    { data?: MemberEntity[]; members?: MemberEntity[] } | MemberEntity[]
  >(`/admin/members?search=${encodeURIComponent(clean)}&limit=100`, {
    resource: 'member',
  });

  const list: MemberEntity[] = Array.isArray(res) ? res : res.data || res.members || [];

  const matches = list.filter(
    (m) =>
      m.username.toLowerCase() === clean.toLowerCase() ||
      (m.globalName && m.globalName.toLowerCase() === clean.toLowerCase()) ||
      (m.displayName && m.displayName.toLowerCase() === clean.toLowerCase()),
  );

  const firstMatch = matches[0];
  if (matches.length === 1 && firstMatch) {
    return {
      discordId: firstMatch.memberId || firstMatch.discordId || firstMatch.id || '',
      username: firstMatch.username,
    };
  }

  if (matches.length > 1) {
    const candList = matches
      .map((m) => `  - @${m.username} (id: ${m.memberId || m.discordId || m.id})`)
      .join('\n');
    throw new CliError(
      `Member "${idOrUsername}" is ambiguous, matches multiple members:\n${candList}\n  hint: specify the Discord ID directly`,
      ExitCode.Usage,
    );
  }

  throw new CliError(
    `Member "${idOrUsername}" not found\n  hint: check the username, or specify the Discord ID directly`,
    ExitCode.NotFound,
  );
}

/**
 * Resolves an inbound webhook by ID, slug, or name.
 */
export async function resolveWebhook(
  client: ApiClient,
  idOrNameOrSlug: string,
): Promise<WebhookEntity> {
  const webhooks = await client.get<WebhookEntity[]>('/admin/inbound-webhooks', {
    resource: 'webhook',
  });

  const exactId = webhooks.find((w) => w.id === idOrNameOrSlug);
  if (exactId) return exactId;

  const matches = webhooks.filter(
    (w) =>
      w.id.toLowerCase() === idOrNameOrSlug.toLowerCase() ||
      (w.slug && w.slug.toLowerCase() === idOrNameOrSlug.toLowerCase()) ||
      w.name.toLowerCase() === idOrNameOrSlug.toLowerCase(),
  );

  const firstMatch = matches[0];
  if (matches.length === 1 && firstMatch) return firstMatch;
  if (matches.length > 1) {
    const list = matches.map((m) => `  - ${m.name} (id: ${m.id}, slug: ${m.slug})`).join('\n');
    throw new CliError(
      `Webhook name "${idOrNameOrSlug}" is ambiguous, matches multiple webhooks:\n${list}\n  hint: specify the webhook ID or slug directly`,
      ExitCode.Usage,
    );
  }

  throw new CliError(
    `Webhook "${idOrNameOrSlug}" not found\n  hint: list webhooks with \`mcid-cli webhook list\``,
    ExitCode.NotFound,
  );
}
