import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ACCESS_LEVELS,
  ACCESS_RESOURCES,
  LEVEL_DESCRIPTIONS,
  RESOURCE_DESCRIPTIONS,
  isAccessLevel,
  isAccessResource,
  type AccessLevel,
  type AccessResource,
  type GrantLevel,
} from '../../common/permissions/catalog';
import type { ClientInfo } from '../../common/utils/client-info.util';
import { AuditService } from '../audit/audit.service';
import { PermissionCacheService } from '../permissions/permission-cache.service';
import { AdminAccessRepository } from './admin-access.repository';
import { AdminAccessService } from './admin-access.service';

type Entry<L> = { resource: AccessResource; level: L };

/**
 * Root-only editing of role grants and member overrides. Validates against
 * the catalog, refuses to touch root, clears the cache and writes an audit
 * row with the grants before and after.
 */
@Injectable()
export class AdminAccessGrantsService {
  constructor(
    private readonly repository: AdminAccessRepository,
    private readonly access: AdminAccessService,
    private readonly cache: PermissionCacheService,
    private readonly audit: AuditService,
  ) {}

  getCatalog() {
    return {
      resources: ACCESS_RESOURCES.map((key) => ({
        key,
        description: RESOURCE_DESCRIPTIONS[key],
      })),
      levels: ACCESS_LEVELS.map((key) => ({
        key,
        description: LEVEL_DESCRIPTIONS[key],
      })),
    };
  }

  async listRoles() {
    const mainServerId = await this.requireMainServer();
    const roles = await this.repository.listServerRoles(mainServerId);
    const grants = await this.repository.findGrantsForRoles(
      roles.map((r) => r.id),
    );

    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      root: this.access.isRootRole(role.id),
      grants: Object.fromEntries(
        grants
          .filter((g) => g.roleId === role.id)
          .map((g) => [g.resource, g.level]),
      ),
    }));
  }

  async setRoleGrants(
    actorId: string,
    roleId: string,
    input: Record<string, unknown>,
    client?: ClientInfo,
  ) {
    const parsed = this.parse(input);
    const mainServerId = await this.requireMainServer();
    const role = await this.repository.findRole(roleId);
    if (!role || role.serverId !== mainServerId) {
      throw new NotFoundException('Role not found in the main server');
    }
    if (this.access.isRootRole(roleId)) {
      throw new BadRequestException(
        'Root roles hold full access and cannot be given grants',
      );
    }

    // A role grant is never `none`: leaving a resource out (or `none`) removes it.
    const rows = parsed.filter(
      (e): e is Entry<GrantLevel> => e.level !== 'none',
    );
    const before = await this.repository.findGrantsForRoles([roleId]);

    await this.repository.replaceRoleGrants(roleId, rows, actorId);
    await this.cache.invalidateAllAdminAccess();

    const after = this.toMap(rows);
    this.audit.logAction({
      actorId,
      actionType: 'access',
      action: 'role_grants_updated',
      entityType: 'role',
      entityId: roleId,
      details: { before: this.toMap(before), after },
      ipAddress: client?.ipAddress ?? null,
      userAgent: client?.userAgent ?? null,
      severity: 'info',
    });
    return { roleId, grants: after };
  }

  async getMemberOverrides(memberId: string) {
    await this.requireMember(memberId);
    return {
      memberId,
      overrides: this.toMap(
        await this.repository.findMemberOverrides(memberId),
      ),
    };
  }

  async setMemberOverrides(
    actorId: string,
    memberId: string,
    input: Record<string, unknown>,
    client?: ClientInfo,
  ) {
    const parsed = this.parse(input);
    await this.requireMember(memberId);
    await this.refuseRootMember(memberId);

    const before = await this.repository.findMemberOverrides(memberId);
    await this.repository.replaceMemberOverrides(memberId, parsed, actorId);
    await this.cache.invalidateMember(memberId);

    const after = this.toMap(parsed);
    this.audit.logAction({
      actorId,
      actionType: 'access',
      action: 'member_overrides_updated',
      entityType: 'member',
      entityId: memberId,
      details: { before: this.toMap(before), after },
      ipAddress: client?.ipAddress ?? null,
      userAgent: client?.userAgent ?? null,
      severity: 'info',
    });
    return { memberId, overrides: after };
  }

  async removeMemberOverride(
    actorId: string,
    memberId: string,
    resource: string,
    client?: ClientInfo,
  ) {
    if (!isAccessResource(resource)) {
      throw new BadRequestException(`Unknown resource '${resource}'`);
    }
    await this.requireMember(memberId);

    const removed = await this.repository.deleteMemberOverride(
      memberId,
      resource,
    );
    if (!removed) {
      throw new NotFoundException(
        `No override on '${resource}' for this member`,
      );
    }
    await this.cache.invalidateMember(memberId);

    this.audit.logAction({
      actorId,
      actionType: 'access',
      action: 'member_override_removed',
      entityType: 'member',
      entityId: memberId,
      details: { resource },
      ipAddress: client?.ipAddress ?? null,
      userAgent: client?.userAgent ?? null,
      severity: 'info',
    });
  }

  async getMemberEffective(memberId: string) {
    const profile = await this.repository.findMemberProfile(memberId);
    if (!profile) throw new NotFoundException('Member not found');

    const { root, access } = await this.access.getEffectiveAccess(memberId);
    return {
      memberId,
      username: profile.username,
      displayName:
        profile.displayName ?? profile.globalName ?? profile.username,
      avatar: profile.avatar,
      root,
      access,
    };
  }

  /**
   * Every member who has an override, for the Access screen's overview. Not paginated: the list is
   * bounded by the size of the club. `root` marks a member whose overrides are inactive because
   * they currently hold a root role.
   */
  async listMemberOverrides() {
    const rows = await this.repository.listOverrideRows();

    const byMember = new Map<
      string,
      {
        memberId: string;
        username: string;
        displayName: string;
        avatar: string | null;
        overrides: Record<string, AccessLevel>;
      }
    >();
    for (const row of rows) {
      const entry = byMember.get(row.memberId) ?? {
        memberId: row.memberId,
        username: row.username,
        displayName: row.displayName ?? row.globalName ?? row.username,
        avatar: row.avatar,
        overrides: {},
      };
      entry.overrides[row.resource] = row.level;
      byMember.set(row.memberId, entry);
    }

    const members = [...byMember.values()].sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, {
          sensitivity: 'base',
        }) || a.memberId.localeCompare(b.memberId),
    );
    const roots = await Promise.all(
      members.map(
        async (member) =>
          (await this.access.getEffectiveAccess(member.memberId)).root,
      ),
    );

    return {
      members: members.map((member, index) => ({
        ...member,
        root: roots[index],
      })),
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private parse(input: Record<string, unknown>): Entry<AccessLevel>[] {
    return Object.entries(input).map(([resource, level]) => {
      if (!isAccessResource(resource)) {
        throw new BadRequestException(`Unknown resource '${resource}'`);
      }
      if (!isAccessLevel(level)) {
        throw new BadRequestException(
          `Invalid level '${String(level)}' for '${resource}'`,
        );
      }
      return { resource, level };
    });
  }

  private toMap(
    entries: Array<{ resource: AccessResource; level: AccessLevel }>,
  ) {
    return Object.fromEntries(entries.map((e) => [e.resource, e.level]));
  }

  private async requireMainServer(): Promise<string> {
    const id = await this.repository.findMainServerId();
    if (!id) throw new ForbiddenException('No main server configured');
    return id;
  }

  private async requireMember(memberId: string): Promise<void> {
    if (!(await this.repository.memberExists(memberId))) {
      throw new NotFoundException('Member not found');
    }
  }

  private async refuseRootMember(memberId: string): Promise<void> {
    const { root } = await this.access.getEffectiveAccess(memberId);
    if (root) {
      throw new BadRequestException(
        'Root admins hold full access and cannot be given overrides',
      );
    }
  }
}
