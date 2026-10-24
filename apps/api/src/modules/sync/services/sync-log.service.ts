import type { SyncChangeAction } from '@mcid/contracts';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SyncRepository } from '../sync.repository';
import { ServersRepository } from '../../servers/servers.repository';
import { SyncChangeEntry } from '../sync-types';
import { SyncStatusDto } from '../dto/sync-status.dto';
import { SyncLogDto, SyncLogsResponseDto } from '../dto/sync-log.dto';
import {
  SyncChangeDetailDto,
  SyncChangeDetailsResponseDto,
} from '../dto/sync-change-detail.dto';

@Injectable()
export class SyncLogService {
  private readonly logger = new Logger(SyncLogService.name);

  constructor(
    private readonly syncRepository: SyncRepository,
    private readonly serversRepository: ServersRepository,
  ) {}

  /**
   * Batch-insert buffered change records in chunks of 500 to stay within
   * DB parameter limits.
   */
  async flushChangeBuffer(buffer: SyncChangeEntry[]): Promise<void> {
    const CHUNK = 500;
    for (let i = 0; i < buffer.length; i += CHUNK) {
      await this.syncRepository.createChangeDetails(buffer.slice(i, i + CHUNK));
    }
  }

  /**
   * Creates a lightweight "incremental" sync log for a real-time Discord
   * gateway event and records the single change detail against it.
   */
  async recordEventChange(
    serverId: string,
    entityType: string,
    entityId: string,
    action: string,
    description?: string,
    details?: string,
  ): Promise<void> {
    try {
      const now = new Date();
      const log = await this.syncRepository.createLog(
        serverId,
        'incremental',
        'success',
        now,
      );
      await this.syncRepository.updateLog(log.id, {
        membersSynced: entityType === 'member' ? 1 : 0,
        rolesSynced: entityType === 'role' ? 1 : 0,
        finishedAt: now,
        message: description,
      });
      await this.syncRepository.createChangeDetail({
        syncLogId: log.id,
        serverId,
        entityType,
        entityId,
        action,
        description,
        details,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record event change detail: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getSyncStatus(serverId: string): Promise<SyncStatusDto | null> {
    const log = await this.syncRepository.getLatestLog(serverId);
    if (!log) return null;

    return {
      serverId: log.serverId,
      lastSyncAt: log.finishedAt?.toISOString() ?? null,
      status: log.status,
      membersSynced: log.membersSynced,
      rolesSynced: log.rolesSynced,
      message: log.message ?? undefined,
      startedAt: log.startedAt.toISOString(),
      finishedAt: log.finishedAt?.toISOString(),
    };
  }

  async getAllServersSyncStatus(): Promise<SyncStatusDto[]> {
    const activeServers = await this.serversRepository.findAllActive();
    return Promise.all(
      activeServers.map(async (server): Promise<SyncStatusDto> => {
        const log = await this.syncRepository.getLatestLog(server.id);
        return {
          serverId: server.id,
          lastSyncAt: log?.finishedAt?.toISOString() ?? null,
          status: log?.status ?? 'never',
          membersSynced: log?.membersSynced ?? 0,
          rolesSynced: log?.rolesSynced ?? 0,
          message: log?.message ?? undefined,
          startedAt: log?.startedAt?.toISOString() ?? '',
          finishedAt: log?.finishedAt?.toISOString(),
        };
      }),
    );
  }

  async getSyncLogs(
    serverId: string,
    limit = 20,
    offset = 0,
  ): Promise<SyncLogsResponseDto> {
    const [logs, total] = await Promise.all([
      this.syncRepository.getLogs(serverId, limit, offset),
      this.syncRepository.countLogs(serverId),
    ]);

    return {
      total,
      logs: logs.map((log): SyncLogDto => ({
        id: log.id,
        serverId: log.serverId,
        syncType: log.syncType,
        status: log.status,
        membersSynced: log.membersSynced,
        rolesSynced: log.rolesSynced,
        message: log.message ?? undefined,
        startedAt: log.startedAt.toISOString(),
        finishedAt: log.finishedAt?.toISOString(),
      })),
    };
  }

  async getSyncChangeDetails(
    syncLogId: number,
    limit = 100,
    offset = 0,
    action?: SyncChangeAction,
  ): Promise<SyncChangeDetailsResponseDto> {
    const log = await this.syncRepository.getLogById(syncLogId);
    if (!log) throw new NotFoundException(`Sync log ${syncLogId} not found`);

    const [changes, total] = await Promise.all([
      this.syncRepository.getChangeDetails(syncLogId, limit, offset, action),
      this.syncRepository.countChangeDetails(syncLogId, action),
    ]);

    return {
      total,
      changes: changes.map((c): SyncChangeDetailDto => ({
        id: c.id,
        syncLogId: c.syncLogId,
        serverId: c.serverId,
        entityType: c.entityType,
        entityId: c.entityId,
        action: c.action,
        description: c.description ?? undefined,
        details: c.details ?? undefined,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }
}
