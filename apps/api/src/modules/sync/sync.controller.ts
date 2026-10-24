import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SyncService } from './sync.service';
import { TriggerSyncDto } from './dto/trigger-sync.dto';
import { SyncStatusDto } from './dto/sync-status.dto';
import { SyncLogsQueryDto } from './dto/sync-logs-query.dto';
import { SYNC_CHANGE_ACTIONS, type SyncChangeAction } from '@mcid/contracts';
import { SyncLogsResponseDto } from './dto/sync-log.dto';
import { SyncChangeDetailsResponseDto } from './dto/sync-change-detail.dto';
import { AdminAccessGuard } from '../../common/guards/admin-access.guard';
import { RequirePermission } from '../../common/decorators/admin-access.decorator';

@ApiTags('Sync')
@ApiBearerAuth('session-token')
@UseGuards(AdminAccessGuard)
@Controller('admin/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  // ─── Trigger Sync ──────────────────────────────────────────────

  @Post('full')
  @RequirePermission('sync', 'write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Trigger a full sync',
    description:
      'Queues a manual sync for one or more servers. ' +
      'Use `target` to limit the sync to MEMBERS, ROLES, or ALL (default). ' +
      'Omit `serverIds` to sync all active servers.',
  })
  @ApiBody({ type: TriggerSyncDto })
  @ApiAcceptedResponse({
    description: 'Sync queued.',
    schema: {
      example: {
        results: [
          {
            serverId: '123456789012345678',
            syncId: 42,
          },
        ],
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Server not found.' })
  @ApiConflictResponse({
    description: 'Sync already queued or in progress.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({ description: 'Invalid request body.' })
  async triggerFullSync(@Body() dto: TriggerSyncDto) {
    const serversToSync: string[] =
      dto.serverIds && dto.serverIds.length > 0 ? dto.serverIds : [];

    return this.syncService.triggerMultipleSyncs(serversToSync, dto.target);
  }

  // ─── Sync Status ───────────────────────────────────────────────

  @Get('status')
  @RequirePermission('sync', 'read')
  @ApiOperation({ summary: 'Get the latest sync status for a specific server' })
  @ApiQuery({
    name: 'serverId',
    required: true,
    type: String,
    example: '123456789012345678',
  })
  @ApiOkResponse({
    description: 'Sync status retrieved successfully.',
    type: SyncStatusDto,
  })
  @ApiNotFoundResponse({ description: 'No sync logs found for this server.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({ description: 'Invalid serverId format.' })
  async getSyncStatus(
    @Query('serverId') serverId: string,
  ): Promise<SyncStatusDto> {
    const status = await this.syncService.getSyncStatus(serverId);
    if (!status) {
      throw new NotFoundException('No sync logs found for this server');
    }
    return status;
  }

  @Get('status/all')
  @RequirePermission('sync', 'read')
  @ApiOperation({
    summary: 'Get latest sync status for all active servers',
    description:
      'Returns the most recent sync result for every active server managed by MCID.',
  })
  @ApiOkResponse({
    description: 'All server sync statuses retrieved.',
    type: [SyncStatusDto],
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({ description: 'Invalid parameter.' })
  async getAllServersSyncStatus(): Promise<SyncStatusDto[]> {
    return this.syncService.getAllServersSyncStatus();
  }

  // ─── Sync Logs ─────────────────────────────────────────────────

  @Get('logs')
  @RequirePermission('sync', 'read')
  @ApiOperation({
    summary: 'Get paginated sync logs for a server',
    description:
      'Returns a paginated list of all sync operations run against a specific server.',
  })
  @ApiQuery({
    name: 'serverId',
    required: true,
    type: String,
    example: '123456789012345678',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiQuery({
    name: 'action',
    required: false,
    enum: SYNC_CHANGE_ACTIONS,
    description: 'Filter changes by what happened (added, removed, updated, ...)',
  })
  @ApiOkResponse({
    description: 'Sync logs retrieved successfully.',
    type: SyncLogsResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({ description: 'Invalid serverId, limit, or offset.' })
  async getSyncLogs(
    @Query() query: SyncLogsQueryDto,
  ): Promise<SyncLogsResponseDto> {
    return this.syncService.getSyncLogs(
      query.serverId,
      query.limit,
      query.offset,
    );
  }

  // ─── Sync Change Details ───────────────────────────────────

  @Get('logs/:syncLogId/changes')
  @RequirePermission('sync', 'read')
  @ApiOperation({
    summary: 'Get granular change details for a specific sync log',
    description:
      'Returns a paginated list of individual entity-level changes ' +
      '(member added/removed, role updated, etc.) recorded during a sync operation.',
  })
  @ApiParam({ name: 'syncLogId', type: Number, example: 42 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 100 })
  @ApiQuery({ name: 'offset', required: false, type: Number, example: 0 })
  @ApiQuery({
    name: 'action',
    required: false,
    enum: SYNC_CHANGE_ACTIONS,
    description: 'Filter changes by what happened (added, removed, updated, ...)',
  })
  @ApiOkResponse({
    description: 'Sync change details retrieved successfully.',
    type: SyncChangeDetailsResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Sync log not found.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({
    description: 'Invalid syncLogId, limit, or offset.',
  })
  async getSyncChangeDetails(
    @Param('syncLogId', ParseIntPipe) syncLogId: number,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('action') action?: SyncChangeAction,
  ): Promise<SyncChangeDetailsResponseDto> {
    return this.syncService.getSyncChangeDetails(syncLogId, limit, offset, action);
  }
}
