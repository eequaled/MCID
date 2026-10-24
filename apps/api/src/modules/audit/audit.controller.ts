import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AdminAccessGuard } from '../../common/guards/admin-access.guard';
import { RequirePermission } from '../../common/decorators/admin-access.decorator';
import { AuditService } from './audit.service';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';
import { QueryAuthFailuresDto } from './dto/query-auth-failures.dto';
import { QueryUsageDto } from './dto/query-usage.dto';

// ── Audit Logs Controller ────────────���──────────────────────────────────

@ApiTags('Audit')
@ApiBearerAuth('session-token')
@Controller('admin/audit')
@UseGuards(AdminAccessGuard)
@RequirePermission('audit', 'read')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('logs')
  @ApiOperation({
    summary: 'Get audit logs',
    description: 'Query audit logs with filtering and pagination.',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    description: 'Start date (ISO 8601)',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    description: 'End date (ISO 8601)',
  })
  @ApiQuery({
    name: 'actorId',
    required: false,
    description: 'Filter by admin member ID',
  })
  @ApiQuery({
    name: 'actionType',
    required: false,
    enum: [
      'auth',
      'project',
      'server',
      'role',
      'webhook',
      'member',
      'sync',
      'access',
      'permission',
    ],
  })
  @ApiQuery({
    name: 'severity',
    required: false,
    enum: ['info', 'warning', 'error'],
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max results (1-500, default 50)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Pagination offset',
  })
  @ApiOkResponse({
    description: 'Audit logs retrieved.',
    schema: {
      example: {
        logs: [
          {
            id: 1,
            timestamp: '2026-04-01T12:00:00.000Z',
            actorId: '123456789',
            actorName: 'admin-user',
            actionType: 'project',
            action: 'created',
            entityType: 'project',
            entityId: 'uuid',
            details: { method: 'POST', path: '/admin/projects' },
            ipAddress: '192.168.1.1',
            severity: 'info',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({ description: 'Invalid query parameters.' })
  getLogs(@Query() dto: QueryAuditLogsDto) {
    return this.auditService.getAuditLogs(dto);
  }

  @Get('logs/export')
  @ApiOperation({
    summary: 'Export audit logs as CSV',
    description:
      'Download audit logs as a CSV file. Supports the same filters as GET /logs.',
  })
  @ApiOkResponse({ description: 'CSV file download.' })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({ description: 'Invalid query parameters.' })
  async exportLogs(
    @Query() dto: QueryAuditLogsDto,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.auditService.getAuditLogsCsv(dto);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-logs-${Date.now()}.csv"`,
    );
    res.send(csv);
  }
}

// ── Monitoring Controller ──���─────────────────────��──────────────────────

@ApiTags('Monitoring')
@ApiBearerAuth('session-token')
@Controller('admin/monitoring')
@UseGuards(AdminAccessGuard)
@RequirePermission('monitoring', 'read')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class MonitoringController {
  constructor(private readonly auditService: AuditService) {}

  @Get('health')
  @ApiOperation({
    summary: 'System health check',
    description: 'Returns health status for API, database, Redis, and Discord.',
  })
  @ApiOkResponse({
    description: 'Health status retrieved.',
    schema: {
      example: {
        api: { status: 'healthy', uptime: 86400, responseTime: 2 },
        database: { status: 'connected', queryTime: 5, connections: 10 },
        redis: { status: 'connected', hitRate: 0.97, memoryUsed: '1.25M' },
        discord: { status: 'connected', guilds: 3, latency: 45 },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  async getHealth() {
    const start = Date.now();
    const health = await this.auditService.getHealthStatus();
    health.api.responseTime = Date.now() - start;
    return health;
  }

  @Get('usage')
  @ApiOperation({
    summary: 'API usage statistics',
    description:
      'Returns request counts aggregated by period, project, and endpoint.',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['7d', '30d', '90d'],
    description: 'Time period (default 30d)',
  })
  @ApiQuery({
    name: 'projectId',
    required: false,
    description: 'Filter by project ID',
  })
  @ApiOkResponse({
    description: 'Usage statistics retrieved.',
    schema: {
      example: {
        totalRequests: 1500,
        byProject: [
          {
            projectId: 'uuid',
            projectName: 'My Project',
            requests: 500,
            errors: 10,
          },
        ],
        byEndpoint: [
          {
            endpoint: '/admin/projects',
            method: 'GET',
            count: 200,
            avgResponseTime: 15,
          },
        ],
        errors: { total: 25, byType: { '4xx': 20, '5xx': 5 } },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({ description: 'Invalid query parameters.' })
  getUsage(@Query() dto: QueryUsageDto) {
    return this.auditService.getUsageStats(dto);
  }

  @Get('auth-failures')
  @ApiOperation({
    summary: 'Recent authentication failures',
    description:
      'Returns failed admin logins, rejected session tokens and rejected ' +
      'API keys recorded in the audit log, newest first. `attemptedActor` ' +
      'is the Discord user id or the API key prefix when known; `actorId` ' +
      'is set when the credential resolved to a member. `path` is null for ' +
      'failed OAuth logins, which the callback service records instead of a ' +
      'route.',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    description: 'Start date (ISO 8601)',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    description: 'End date (ISO 8601)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max results (1-500, default 50)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Pagination offset',
  })
  @ApiOkResponse({
    description: 'Authentication failures retrieved.',
    schema: {
      example: {
        failures: [
          {
            id: 42,
            timestamp: '2026-04-01T12:00:00.000Z',
            ipAddress: '192.168.1.1',
            reason: 'Invalid API key',
            attemptedActor: 'pk_1a2b3c4d',
            actorId: null,
            path: '/members/123456789012345678',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required.' })
  @ApiForbiddenResponse({ description: 'System Admin access required.' })
  @ApiBadRequestResponse({ description: 'Invalid query parameters.' })
  getAuthFailures(@Query() dto: QueryAuthFailuresDto) {
    return this.auditService.getAuthFailures(dto);
  }
}
