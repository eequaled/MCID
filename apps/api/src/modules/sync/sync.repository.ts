import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../database/entities';
import { serverSyncLogs } from '../../database/entities/server-sync-log.entity';
import { syncChangeDetails } from '../../database/entities/sync-change-detail.entity';
import { eq, and, desc, sql, asc, isNull, lt, or } from 'drizzle-orm';
import { SyncTarget } from './dto/trigger-sync.dto';
import type { SyncChangeAction, SyncLogStatus, SyncType } from '@mcid/contracts';

export type { SyncLogStatus };

@Injectable()
export class SyncRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async createLog(
    serverId: string,
    syncType: SyncType,
    status: SyncLogStatus,
    startedAt: Date,
    target: SyncTarget = SyncTarget.ALL,
  ): Promise<typeof serverSyncLogs.$inferSelect> {
    const [log] = await this.db
      .insert(serverSyncLogs)
      .values({
        serverId,
        syncType,
        status,
        target,
        startedAt,
        membersSynced: 0,
        rolesSynced: 0,
      })
      .returning();
    return log;
  }

  async updateLog(
    id: number,
    updates: Partial<typeof serverSyncLogs.$inferInsert>,
  ): Promise<typeof serverSyncLogs.$inferSelect | null> {
    const [log] = await this.db
      .update(serverSyncLogs)
      .set({ ...updates, finishedAt: updates.finishedAt ?? null })
      .where(eq(serverSyncLogs.id, id))
      .returning();
    return log ?? null;
  }

  async getInProgressLog(
    serverId: string,
  ): Promise<typeof serverSyncLogs.$inferSelect | null> {
    const [log] = await this.db
      .select()
      .from(serverSyncLogs)
      .where(
        and(
          eq(serverSyncLogs.serverId, serverId),
          eq(serverSyncLogs.status, 'in_progress'),
        ),
      )
      .limit(1);
    return log ?? null;
  }

  async getActiveLog(
    serverId: string,
  ): Promise<typeof serverSyncLogs.$inferSelect | null> {
    const [log] = await this.db
      .select()
      .from(serverSyncLogs)
      .where(
        and(
          eq(serverSyncLogs.serverId, serverId),
          or(
            eq(serverSyncLogs.status, 'queued'),
            eq(serverSyncLogs.status, 'in_progress'),
          ),
        ),
      )
      .orderBy(desc(serverSyncLogs.startedAt), desc(serverSyncLogs.id))
      .limit(1);
    return log ?? null;
  }

  async claimNextRunnableLog(
    staleBefore: Date,
    claimedAt = new Date(),
  ): Promise<typeof serverSyncLogs.$inferSelect | null> {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(serverSyncLogs)
        .where(
          or(
            eq(serverSyncLogs.status, 'queued'),
            and(
              eq(serverSyncLogs.status, 'in_progress'),
              or(
                isNull(serverSyncLogs.heartbeatAt),
                lt(serverSyncLogs.heartbeatAt, staleBefore),
              ),
            ),
          ),
        )
        .orderBy(asc(serverSyncLogs.startedAt), asc(serverSyncLogs.id))
        .limit(1);

      if (!candidate) return null;

      const claimWhere =
        candidate.status === 'queued'
          ? and(
              eq(serverSyncLogs.id, candidate.id),
              eq(serverSyncLogs.status, 'queued'),
            )
          : and(
              eq(serverSyncLogs.id, candidate.id),
              eq(serverSyncLogs.status, 'in_progress'),
              or(
                isNull(serverSyncLogs.heartbeatAt),
                lt(serverSyncLogs.heartbeatAt, staleBefore),
              ),
            );

      const [claimed] = await tx
        .update(serverSyncLogs)
        .set({
          status: 'in_progress',
          startedAt: claimedAt,
          heartbeatAt: claimedAt,
          finishedAt: null,
        })
        .where(claimWhere)
        .returning();

      return claimed ?? null;
    });
  }

  async touchHeartbeat(
    syncLogId: number,
    heartbeatAt: Date,
  ): Promise<typeof serverSyncLogs.$inferSelect | null> {
    const [log] = await this.db
      .update(serverSyncLogs)
      .set({ heartbeatAt })
      .where(eq(serverSyncLogs.id, syncLogId))
      .returning();
    return log ?? null;
  }

  async getLatestLog(
    serverId: string,
  ): Promise<typeof serverSyncLogs.$inferSelect | null> {
    const [log] = await this.db
      .select()
      .from(serverSyncLogs)
      .where(eq(serverSyncLogs.serverId, serverId))
      .orderBy(desc(serverSyncLogs.startedAt))
      .limit(1);
    return log ?? null;
  }

  async getLogs(
    serverId: string,
    limit = 20,
    offset = 0,
  ): Promise<(typeof serverSyncLogs.$inferSelect)[]> {
    return this.db
      .select()
      .from(serverSyncLogs)
      .where(eq(serverSyncLogs.serverId, serverId))
      .orderBy(desc(serverSyncLogs.startedAt))
      .limit(limit)
      .offset(offset);
  }

  async countLogs(serverId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(serverSyncLogs)
      .where(eq(serverSyncLogs.serverId, serverId));
    return result?.count ?? 0;
  }

  async getLogById(
    syncLogId: number,
  ): Promise<typeof serverSyncLogs.$inferSelect | null> {
    const [log] = await this.db
      .select()
      .from(serverSyncLogs)
      .where(eq(serverSyncLogs.id, syncLogId))
      .limit(1);
    return log ?? null;
  }

  // ─── Sync Change Details ────────────────────────────────────

  async createChangeDetail(data: {
    syncLogId: number;
    serverId: string;
    entityType: string;
    entityId: string;
    action: string;
    description?: string;
    details?: string;
  }): Promise<typeof syncChangeDetails.$inferSelect> {
    const [row] = await this.db
      .insert(syncChangeDetails)
      .values(data)
      .returning();
    return row;
  }

  async createChangeDetails(
    items: {
      syncLogId: number;
      serverId: string;
      entityType: string;
      entityId: string;
      action: string;
      description?: string;
      details?: string;
    }[],
  ): Promise<void> {
    if (!items.length) return;
    await this.db.insert(syncChangeDetails).values(items);
  }

  async getChangeDetails(
    syncLogId: number,
    limit = 100,
    offset = 0,
    action?: SyncChangeAction,
  ): Promise<(typeof syncChangeDetails.$inferSelect)[]> {
    const conditions = action
      ? and(
          eq(syncChangeDetails.syncLogId, syncLogId),
          eq(syncChangeDetails.action, action),
        )
      : eq(syncChangeDetails.syncLogId, syncLogId);

    return this.db
      .select()
      .from(syncChangeDetails)
      .where(conditions)
      .orderBy(desc(syncChangeDetails.id))
      .limit(limit)
      .offset(offset);
  }

  async countChangeDetails(
    syncLogId: number,
    action?: SyncChangeAction,
  ): Promise<number> {
    const conditions = action
      ? and(
          eq(syncChangeDetails.syncLogId, syncLogId),
          eq(syncChangeDetails.action, action),
        )
      : eq(syncChangeDetails.syncLogId, syncLogId);

    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncChangeDetails)
      .where(conditions);
    return result?.count ?? 0;
  }
}
