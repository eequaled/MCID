import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

const ACTION_TYPES = [
  'auth',
  'project',
  'server',
  'role',
  'webhook',
  'member',
  'sync',
  'access',
  'permission',
] as const;

const SEVERITIES = ['info', 'warning', 'error'] as const;

export class QueryAuditLogsDto {
  @ApiPropertyOptional({
    description: 'Start date (ISO 8601)',
    example: '2026-03-01T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'End date (ISO 8601)',
    example: '2026-04-01T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Filter by actor (member ID)' })
  @IsOptional()
  @IsString()
  actorId?: string;

  @ApiPropertyOptional({
    description: 'Filter by action type',
    enum: ACTION_TYPES,
  })
  @IsOptional()
  @IsIn(ACTION_TYPES)
  actionType?: string;

  @ApiPropertyOptional({
    description: 'Filter by severity',
    enum: SEVERITIES,
  })
  @IsOptional()
  @IsIn(SEVERITIES)
  severity?: string;

  @ApiPropertyOptional({ description: 'Max results (1-500)', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Pagination offset', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
