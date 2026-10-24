import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, ilike, inArray, or, sql, SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from '../../database/database.module';
import * as schema from '../../database/entities';

/** Raw member row returned from the database */
export interface RawMemberRow {
  id: string;
  username: string;
  globalName: string | null;
  displayName: string | null;
  avatar: string | null;
  isClubMember: boolean;
  syncedAt: Date | null;
}

/** Raw membership row with server info */
export interface RawMembershipRow {
  memberId: string;
  serverId: string;
  joinedAt: Date | null;
  serverName: string;
  serverIcon: string | null;
  isMainServer: boolean;
}

/** Raw role row for a member across servers */
export interface RawMemberRoleRow {
  roleId: string;
  roleName: string;
  roleColor: number | null;
  rolePosition: number | null;
  serverId: string;
}

/** Raw role row with memberId (for batch queries) */
export interface RawBatchMemberRoleRow {
  memberId: string;
  serverId: string;
  roleName: string;
}

/** Lightweight member row for list queries */
export interface RawMemberListRow {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

/** Batch membership row (includes memberIds) */
export interface RawBatchMembershipRow {
  memberId: string;
  serverId: string;
  joinedAt: Date | null;
  serverName: string;
  isMainServer: boolean;
}

@Injectable()
export class AdminMembersRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ───────────────────────── Single member queries ─────────────────────────

  /**
   * Find a member by their Discord ID.
   */
  async findMemberById(discordId: string): Promise<RawMemberRow | null> {
    const rows = await this.db
      .select()
      .from(schema.members)
      .where(eq(schema.members.id, discordId))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      username: row.username,
      globalName: row.globalName,
      displayName: row.displayName,
      avatar: row.avatar,
      isClubMember: row.isClubMember,
      syncedAt: row.syncedAt,
    };
  }

  /**
   * Find all server memberships for a given member, joined with server info.
   */
  async findMembershipsByMemberId(
    discordId: string,
  ): Promise<RawMembershipRow[]> {
    return this.db
      .select({
        memberId: schema.serverMembers.memberId,
        serverId: schema.serverMembers.serverId,
        joinedAt: schema.serverMembers.joinedAt,
        serverName: schema.servers.name,
        serverIcon: schema.servers.icon,
        isMainServer: schema.servers.isMain,
      })
      .from(schema.serverMembers)
      .innerJoin(
        schema.servers,
        eq(schema.serverMembers.serverId, schema.servers.id),
      )
      .where(eq(schema.serverMembers.memberId, discordId));
  }

  /**
   * Find all roles for a member across all servers.
   */
  async findRolesByMemberId(discordId: string): Promise<RawMemberRoleRow[]> {
    return this.db
      .select({
        roleId: schema.serverMemberRoles.roleId,
        roleName: schema.roles.name,
        roleColor: schema.roles.color,
        rolePosition: schema.roles.position,
        serverId: schema.roles.serverId,
      })
      .from(schema.serverMemberRoles)
      .innerJoin(
        schema.roles,
        eq(schema.serverMemberRoles.roleId, schema.roles.id),
      )
      .where(eq(schema.serverMemberRoles.memberId, discordId));
  }

  // ──────────────────────── Cross-server list queries ──────────────────────

  /**
   * Count members matching the given filter/search/serverId/roleId criteria.
   */
  async countMembers(
    filter: 'club' | 'all' = 'all',
    search?: string,
    serverId?: string[],
    roleId?: string[],
    joinedAfter?: string,
  ): Promise<number> {
    const conditions = this.buildMemberConditions(
      filter,
      search,
      serverId,
      roleId,
      joinedAfter,
    );

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.members)
      .where(and(...conditions));

    return count;
  }

  /**
   * Fetch a paginated list of members matching the given filter/search/serverId/roleId criteria.
   */
  async findMembersPaginated(
    filter: 'club' | 'all' = 'all',
    search: string | undefined,
    limit: number,
    offset: number,
    serverId?: string[],
    roleId?: string[],
    joinedAfter?: string,
  ): Promise<RawMemberListRow[]> {
    const conditions = this.buildMemberConditions(
      filter,
      search,
      serverId,
      roleId,
      joinedAfter,
    );

    return this.db
      .select({
        id: schema.members.id,
        username: schema.members.username,
        globalName: schema.members.globalName,
        avatar: schema.members.avatar,
      })
      .from(schema.members)
      .where(and(...conditions))
      .orderBy(schema.members.username)
      .limit(limit)
      .offset(offset);
  }

  /**
   * Fetch server memberships for a batch of member IDs.
   */
  async findMembershipsByMemberIds(
    memberIds: string[],
  ): Promise<RawBatchMembershipRow[]> {
    return this.db
      .select({
        memberId: schema.serverMembers.memberId,
        serverId: schema.serverMembers.serverId,
        joinedAt: schema.serverMembers.joinedAt,
        serverName: schema.servers.name,
        isMainServer: schema.servers.isMain,
      })
      .from(schema.serverMembers)
      .innerJoin(
        schema.servers,
        eq(schema.serverMembers.serverId, schema.servers.id),
      )
      .where(inArray(schema.serverMembers.memberId, memberIds));
  }

  /**
   * Fetch roles (name only) for a batch of member IDs.
   */
  async findRoleNamesByMemberIds(
    memberIds: string[],
  ): Promise<RawBatchMemberRoleRow[]> {
    return this.db
      .select({
        memberId: schema.serverMemberRoles.memberId,
        serverId: schema.roles.serverId,
        roleName: schema.roles.name,
      })
      .from(schema.serverMemberRoles)
      .innerJoin(
        schema.roles,
        eq(schema.serverMemberRoles.roleId, schema.roles.id),
      )
      .where(inArray(schema.serverMemberRoles.memberId, memberIds));
  }

  // ──────────────────────── Private helpers ─────────────────────────────

  /**
   * Build common WHERE conditions for member list queries.
   */
  private buildMemberConditions(
    filter: 'club' | 'all' = 'all',
    search?: string,
    serverId?: string[],
    roleId?: string[],
    joinedAfter?: string,
  ): SQL[] {
    const conditions: SQL[] = [];

    // Filter by specific server or any managed server
    if (serverId && serverId.length > 0) {
      const serverMemberSubquery = this.db
        .selectDistinct({ memberId: schema.serverMembers.memberId })
        .from(schema.serverMembers)
        .where(inArray(schema.serverMembers.serverId, serverId));

      conditions.push(inArray(schema.members.id, serverMemberSubquery));
    } else {
      // Only members who exist in at least one server
      const allMemberIdsInServers = this.db
        .selectDistinct({ memberId: schema.serverMembers.memberId })
        .from(schema.serverMembers);

      conditions.push(inArray(schema.members.id, allMemberIdsInServers));
    }

    if (joinedAfter) {
      const joinedAfterSubquery = this.db
        .selectDistinct({ memberId: schema.serverMembers.memberId })
        .from(schema.serverMembers)
        .where(gte(schema.serverMembers.joinedAt, new Date(joinedAfter)));
      conditions.push(inArray(schema.members.id, joinedAfterSubquery));
    }

    if (search) {
      const searchCondition = or(
        ilike(schema.members.username, `%${search}%`),
        ilike(schema.members.globalName, `%${search}%`),
      );
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    if (filter === 'club') {
      const mainServerSubquery = this.db
        .select({ memberId: schema.serverMembers.memberId })
        .from(schema.serverMembers)
        .innerJoin(
          schema.servers,
          eq(schema.serverMembers.serverId, schema.servers.id),
        )
        .where(eq(schema.servers.isMain, true));

      conditions.push(inArray(schema.members.id, mainServerSubquery));
    }

    if (roleId && roleId.length > 0) {
      const roleSubquery = this.db
        .select({ memberId: schema.serverMemberRoles.memberId })
        .from(schema.serverMemberRoles)
        .where(inArray(schema.serverMemberRoles.roleId, roleId));

      conditions.push(inArray(schema.members.id, roleSubquery));
    }

    return conditions;
  }
}
