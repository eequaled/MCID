import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsIn,
  IsInt,
  Min,
  Max,
  IsArray,
  IsDateString,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * Safely normalizes an unknown query parameter value into a string array.
 * Handles repeated parameters, comma-separated strings, single values,
 * and qs-collapsed plain objects (e.g. when 21+ values exceed qs arrayLimit).
 */
export function toStringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined;

  const rawItems: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'object'
      ? Object.values(value as Record<string, unknown>)
      : [value];

  const result: string[] = [];
  for (const item of rawItems) {
    if (typeof item === 'string') {
      const parts = item.includes(',') ? item.split(',') : [item];
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.length > 0) {
          result.push(trimmed);
        }
      }
    }
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Query parameters for the paginated cross-server member list.
 *
 * GET /admin/members/cross-server?filter=club|all&page=1&limit=20&search=
 */
export class CrossServerQueryDto {
  @ApiPropertyOptional({
    description:
      'Filter type: "club" = only members in the main server, "all" = any managed server',
    enum: ['club', 'all'],
    default: 'all',
    example: 'club',
  })
  @IsIn(['club', 'all'])
  @IsOptional()
  filter: 'club' | 'all' = 'all';

  @ApiPropertyOptional({
    description:
      'Discord server ID(s) to restrict results to members of specific server(s). Supports repeated params (?serverId=A&serverId=B) or comma-separated values (?serverId=A,B).',
    example: ['123456789012345678', '987654321098765432'],
    type: [String],
  })
  @Transform(({ value }): string[] | undefined => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  serverId?: string[];

  @ApiPropertyOptional({
    description:
      'Discord role ID(s) to restrict results to members holding specific role(s). Supports repeated params (?roleId=A&roleId=B) or comma-separated values (?roleId=A,B).',
    example: ['987654321098765432', '876543210987654321'],
    type: [String],
  })
  @Transform(({ value }): string[] | undefined => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  roleId?: string[];

  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    minimum: 1,
    default: 1,
    example: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Search string to filter by username or global name',
    example: 'john',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description:
      'ISO 8601 timestamp — only members who joined a managed server at or after it.',
    example: '2026-03-01T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  joinedAfter?: string;
}

export { CrossServerQueryDto as AdminMembersQueryDto };

/**
 * Query parameters for the export endpoint.
 */
export class ExportQueryDto {
  @ApiPropertyOptional({
    description: 'Filter type for export',
    enum: ['club', 'all'],
    default: 'all',
    example: 'all',
  })
  @IsIn(['club', 'all'])
  @IsOptional()
  filter: 'club' | 'all' = 'all';

  @ApiPropertyOptional({
    description:
      'Discord server ID(s) to filter export data. Supports repeated params (?serverId=A&serverId=B) or comma-separated values (?serverId=A,B).',
    example: ['123456789012345678', '987654321098765432'],
    type: [String],
  })
  @Transform(({ value }): string[] | undefined => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  serverId?: string[];

  @ApiPropertyOptional({
    description:
      'Discord role ID(s) to filter export data. Supports repeated params (?roleId=A&roleId=B) or comma-separated values (?roleId=A,B).',
    example: ['987654321098765432', '876543210987654321'],
    type: [String],
  })
  @Transform(({ value }): string[] | undefined => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  roleId?: string[];

  @ApiPropertyOptional({
    description:
      'Search string to filter export data by username or global name',
    example: 'john',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'Output format',
    enum: ['csv', 'json'],
    default: 'json',
    example: 'json',
  })
  @IsIn(['csv', 'json'])
  @IsOptional()
  format: 'csv' | 'json' = 'json';
}

/**
 * Server summary within a cross-server list item.
 */
export class CrossServerListServerDto {
  @ApiProperty({
    description: 'Discord server ID',
    example: '123456789012345678',
    type: String,
  })
  serverId: string;

  @ApiProperty({
    description: 'Server name',
    example: 'Micro Club Main',
    type: String,
  })
  serverName: string;

  @ApiProperty({
    description: 'Whether this is the main club server',
    example: true,
    type: Boolean,
  })
  isMainServer: boolean;

  @ApiPropertyOptional({
    description: 'ISO date when the member joined this server',
    example: '2025-01-15T10:30:00.000Z',
    nullable: true,
    type: String,
  })
  joinedAt: string | null;

  @ApiProperty({
    description: 'Role names the member holds in this server',
    type: [String],
    example: ['Admin', 'Moderator'],
  })
  roleNames: string[];
}

/**
 * A row in the cross-server list view (lighter than the full detail view).
 */
export class CrossServerListItemDto {
  @ApiProperty({
    description: 'Discord user ID',
    example: '876543210987654321',
    type: String,
  })
  memberId: string;

  @ApiProperty({
    description: 'Discord username',
    example: 'john_doe',
    type: String,
  })
  username: string;

  @ApiPropertyOptional({
    description: 'Discord global display name',
    example: 'John Doe',
    nullable: true,
    type: String,
  })
  globalName: string | null;

  @ApiPropertyOptional({
    description: 'Avatar hash',
    nullable: true,
    type: String,
  })
  avatar: string | null;

  @ApiProperty({
    description: 'Whether the member is in the main club server',
    example: true,
    type: Boolean,
  })
  isClubMember: boolean;

  @ApiProperty({
    description: 'Number of managed servers the member is in',
    example: 3,
    type: Number,
  })
  serverCount: number;

  @ApiProperty({
    description: 'Server details',
    type: () => [CrossServerListServerDto],
  })
  servers: CrossServerListServerDto[];
}

/**
 * Paginated response for the cross-server member list.
 */
export class PaginatedCrossServerListDto {
  @ApiProperty({
    description: 'List of members',
    type: () => [CrossServerListItemDto],
  })
  data: CrossServerListItemDto[];

  @ApiProperty({
    description: 'Total number of matching members',
    example: 150,
    type: Number,
  })
  total: number;

  @ApiProperty({ description: 'Current page number', example: 1, type: Number })
  page: number;

  @ApiProperty({ description: 'Items per page', example: 20, type: Number })
  limit: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 8,
    type: Number,
  })
  totalPages: number;
}
