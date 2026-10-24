import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Guild, GuildMember, User, Role } from 'discord.js';
import { DiscordService } from '../discord/discord.service';
import { ServersRepository } from '../servers/servers.repository';
import { SyncRepository } from './sync.repository';
import { MemberSyncService } from './services/member-sync.service';
import { RoleSyncService } from './services/role-sync.service';
import { ServerSyncService } from './services/server-sync.service';
import { SyncLogService } from './services/sync-log.service';
import type { SyncChangeAction, SyncType } from '@mcid/contracts';
import { SyncChangeEntry } from './sync-types';
import { SyncTarget } from './dto/trigger-sync.dto';
import { SyncStatusDto } from './dto/sync-status.dto';
import { SyncLogsResponseDto } from './dto/sync-log.dto';
import { SyncChangeDetailsResponseDto } from './dto/sync-change-detail.dto';

const SYNC_QUEUE_POLL_INTERVAL_MS = 5000;
const SYNC_QUEUE_HEARTBEAT_INTERVAL_MS = 15000;
const SYNC_QUEUE_LEASE_TIMEOUT_MS = 60000;

@Injectable()
export class SyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private queuePollTimer: NodeJS.Timeout | null = null;
  private isDrainingQueue = false;

  constructor(
    private readonly discordService: DiscordService,
    private readonly serversRepository: ServersRepository,
    private readonly syncRepository: SyncRepository,
    private readonly memberSyncService: MemberSyncService,
    private readonly roleSyncService: RoleSyncService,
    private readonly serverSyncService: ServerSyncService,
    private readonly syncLogService: SyncLogService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') {
      this.logger.log('Skipping sync queue bootstrap in test environment');
      return;
    }

    if (this.queuePollTimer) return;

    this.queuePollTimer = setInterval(() => {
      this.requestQueueDrain();
    }, SYNC_QUEUE_POLL_INTERVAL_MS);
    this.queuePollTimer.unref?.();

    this.requestQueueDrain();
  }

  onModuleDestroy(): void {
    if (!this.queuePollTimer) return;

    clearInterval(this.queuePollTimer);
    this.queuePollTimer = null;
  }

  // ── Bulk sync orchestration ──────────────────────────────────────────

  async triggerFullSync(
    serverId: string,
    target: SyncTarget = SyncTarget.ALL,
  ): Promise<{ syncId: number }> {
    const server = await this.serversRepository.findById(serverId);
    if (!server) throw new NotFoundException('Server not found');

    const activeLog = await this.syncRepository.getActiveLog(serverId);
    if (activeLog) {
      throw new ConflictException(
        'A sync is already queued or in progress for this server',
      );
    }

    const log = await this.syncRepository.createLog(
      serverId,
      'manual',
      'queued',
      new Date(),
      target,
    );
    this.requestQueueDrain();
    return { syncId: log.id };
  }

  async triggerMultipleSyncs(
    serverIds: string[],
    target: SyncTarget = SyncTarget.ALL,
  ): Promise<{
    results: { serverId: string; syncId?: number; error?: string }[];
  }> {
    let targetsToSync = serverIds;
    if (!targetsToSync || targetsToSync.length === 0) {
      const activeServers = await this.serversRepository.findAllActive();
      targetsToSync = activeServers.map((s) => s.id);
      this.logger.log(
        `No serverIds provided. Scheduled sync for all ${targetsToSync.length} active servers.`,
      );
    }
    const results: { serverId: string; syncId?: number; error?: string }[] = [];
    for (const id of targetsToSync) {
      try {
        const result = await this.triggerFullSync(id, target);
        results.push({ serverId: id, syncId: result.syncId });
      } catch (err: unknown) {
        results.push({
          serverId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  }

  private async runFullSync(
    serverId: string,
    syncId: number,
    target: SyncTarget = SyncTarget.ALL,
  ): Promise<void> {
    const heartbeatTimer = this.startHeartbeat(syncId);
    const changeBuffer: SyncChangeEntry[] = [];

    try {
      const guild = await this.discordService.getGuildById(serverId);
      if (!guild) {
        await this.syncRepository.updateLog(syncId, {
          status: 'failed',
          message: 'Guild not found or bot not in server',
          finishedAt: new Date(),
          heartbeatAt: new Date(),
        });
        return;
      }

      const syncStart = new Date();
      let membersSynced = 0;
      let rolesSynced = 0;
      let deactivatedCount = 0;

      await this.serverSyncService.syncServerInfo(
        serverId,
        guild,
        syncStart,
        syncId,
        changeBuffer,
      );

      if (target === SyncTarget.ALL || target === SyncTarget.ROLES) {
        const r = await this.roleSyncService.syncAllRoles(
          guild,
          syncId,
          changeBuffer,
        );
        rolesSynced += r.rolesSynced;
      }

      if (target === SyncTarget.ALL || target === SyncTarget.MEMBERS) {
        const m = await this.memberSyncService.syncAllMembers(
          guild,
          syncId,
          syncStart,
          changeBuffer,
        );
        membersSynced += m.membersSynced;
        rolesSynced += m.rolesSynced;
        deactivatedCount = m.deactivatedCount;
      }

      await this.syncLogService.flushChangeBuffer(changeBuffer);
      await this.syncRepository.updateLog(syncId, {
        status: 'success',
        membersSynced,
        rolesSynced,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        message: `Sync completed. ${deactivatedCount} members marked inactive.`,
      });
    } catch (error: unknown) {
      this.logger.error(
        `Full sync failed for server ${serverId}`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.syncLogService.flushChangeBuffer(changeBuffer).catch(() => {
        /* best-effort */
      });
      await this.syncRepository.updateLog(syncId, {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  // ── Startup and reconnect sync ───────────────────────────────────────

  /**
   * Queues a full sync for every active server the bot is in, main server
   * first because it decides admin access. Servers with a sync already queued
   * or running are skipped. `syncType` tells the sync log why it ran: 'full'
   * for the boot sync, 'reconnect' for the catch-up after a lost session.
   */
  async startupSyncAll(syncType: SyncType = 'full'): Promise<void> {
    const reason = syncType === 'reconnect' ? 'reconnect' : 'boot';
    const activeServers = (await this.serversRepository.findAllActive()).sort(
      (a, b) => Number(b.isMain) - Number(a.isMain),
    );
    this.logger.log(
      `Starting ${reason} sync for ${activeServers.length} active server(s)`,
    );
    let queuedCount = 0;
    for (const server of activeServers) {
      try {
        const guild = await this.discordService.getGuildById(server.id);
        if (!guild) {
          this.logger.warn(
            `Bot not in server ${server.id} (${server.name}) — skipping ${reason} sync`,
          );
          continue;
        }
        const activeLog = await this.syncRepository.getActiveLog(server.id);
        if (activeLog) {
          this.logger.log(
            `Skipping ${reason} sync for ${server.id} — sync already queued or in progress`,
          );
          continue;
        }
        const log = await this.syncRepository.createLog(
          server.id,
          syncType,
          'queued',
          new Date(),
          SyncTarget.ALL,
        );
        queuedCount += 1;
        this.logger.log(
          `Queued ${reason} sync ${log.id} for server ${server.id}`,
        );
      } catch (err: unknown) {
        this.logger.error(
          `Error scheduling ${reason} sync for server ${server.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    if (queuedCount > 0) {
      this.requestQueueDrain();
    }
  }

  // ── Delegate: Member events ──────────────────────────────────────────

  async processMember(
    guild: Guild,
    guildMember: GuildMember,
    syncTime: Date,
  ): Promise<void> {
    return this.memberSyncService.processMember(guild, guildMember, syncTime);
  }

  async handleMemberAdd(guildMember: GuildMember): Promise<void> {
    return this.memberSyncService.handleMemberAdd(guildMember);
  }

  async handleMemberRemove(guildMember: GuildMember): Promise<void> {
    return this.memberSyncService.handleMemberRemove(guildMember);
  }

  async handleMemberUpdate(
    oldMember: GuildMember,
    newMember: GuildMember,
  ): Promise<void> {
    return this.memberSyncService.handleMemberUpdate(oldMember, newMember);
  }

  async handleUserUpdate(oldUser: User, newUser: User): Promise<void> {
    return this.memberSyncService.handleUserUpdate(oldUser, newUser);
  }

  // ── Delegate: Role events ────────────────────────────────────────────

  async handleRoleCreate(role: Role): Promise<void> {
    return this.roleSyncService.handleRoleCreate(role);
  }

  async handleRoleUpdate(role: Role): Promise<void> {
    return this.roleSyncService.handleRoleUpdate(role);
  }

  async handleRoleDelete(role: Role): Promise<void> {
    return this.roleSyncService.handleRoleDelete(role);
  }

  // ── Delegate: Guild events ────────────────────────────────────────────

  async handleGuildCreate(guild: Guild): Promise<void> {
    const { shouldSync, logId } =
      await this.serverSyncService.prepareGuildCreate(guild);
    if (shouldSync && logId !== undefined) {
      this.logger.log(`Queued guildCreate sync ${logId} for ${guild.id}`);
      this.requestQueueDrain();
    }
  }

  async handleGuildDelete(guild: Guild): Promise<void> {
    return this.serverSyncService.handleGuildDelete(guild);
  }

  async handleGuildUpdate(oldGuild: Guild, newGuild: Guild): Promise<void> {
    return this.serverSyncService.handleGuildUpdate(oldGuild, newGuild);
  }

  // ── Delegate: Query / status ─────────────────────────────────────────

  async getSyncStatus(serverId: string): Promise<SyncStatusDto | null> {
    return this.syncLogService.getSyncStatus(serverId);
  }

  async getAllServersSyncStatus(): Promise<SyncStatusDto[]> {
    return this.syncLogService.getAllServersSyncStatus();
  }

  async getSyncLogs(
    serverId: string,
    limit = 20,
    offset = 0,
  ): Promise<SyncLogsResponseDto> {
    return this.syncLogService.getSyncLogs(serverId, limit, offset);
  }

  async getSyncChangeDetails(
    syncLogId: number,
    limit = 100,
    offset = 0,
    action?: SyncChangeAction,
  ): Promise<SyncChangeDetailsResponseDto> {
    return this.syncLogService.getSyncChangeDetails(
      syncLogId,
      limit,
      offset,
      action,
    );
  }

  async drainQueuedSyncs(): Promise<void> {
    if (this.isDrainingQueue || !this.discordService.getClient().isReady()) {
      return;
    }

    this.isDrainingQueue = true;
    try {
      let claimed = await this.claimNextSyncLog();
      while (claimed) {
        await this.runFullSync(
          claimed.serverId,
          claimed.id,
          claimed.target as SyncTarget,
        );
        claimed = await this.claimNextSyncLog();
      }
    } finally {
      this.isDrainingQueue = false;
    }
  }

  private requestQueueDrain(): void {
    this.drainQueuedSyncs().catch((err: unknown) => {
      this.logger.error(
        'Failed to drain sync queue',
        err instanceof Error ? err.stack : String(err),
      );
    });
  }

  private async claimNextSyncLog() {
    const staleBefore = new Date(Date.now() - SYNC_QUEUE_LEASE_TIMEOUT_MS);
    return this.syncRepository.claimNextRunnableLog(staleBefore);
  }

  private startHeartbeat(syncId: number): NodeJS.Timeout {
    const timer = setInterval(() => {
      this.syncRepository.touchHeartbeat(syncId, new Date()).catch((err) => {
        this.logger.warn(
          `Failed to update sync heartbeat for ${syncId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, SYNC_QUEUE_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return timer;
  }
}
