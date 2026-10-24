import { json, type RouteHandler } from './cli-harness.js';

/** Snowflake-shaped ids so the CLI's snowflake detection treats them as ids. */
export const MAIN_SERVER_ID = '111111111111111111';
export const OTHER_SERVER_ID = '222222222222222222';
export const PROJECT_ID = '3f6f7f9a-4c1a-4a9e-9d7b-2f1f4b6a8c0d';
export const MEMBER_ID = '333333333333333333';
export const WEBHOOK_ID = '5e6f7f9a-4c1a-4a9e-9d7b-2f1f4b6a8c0d';
export const CHANNEL_ID = '444444444444444444';
export const CATEGORY_ID = '555555555555555555';

/** GET /servers row, shaped like ServersService.listServers output. */
export const mainServer = {
  id: MAIN_SERVER_ID,
  name: 'Micro Club',
  icon: null,
  type: 'main',
  isMain: true,
  isActive: true,
  syncFrequencyHours: 1,
  defaultPermissionPolicy: 'deny_all',
  disabledReason: null,
  syncedAt: '2026-10-20T10:00:00.000Z',
  lastSyncAt: '2026-10-23T10:00:00.000Z',
  botConnected: true,
};

export const otherServer = {
  ...mainServer,
  id: OTHER_SERVER_ID,
  name: 'Competition Server',
  type: 'competition',
  isMain: false,
};

export const projectRecord = {
  id: PROJECT_ID,
  name: 'Portal',
  slug: 'portal',
  description: 'The club portal',
  redirectUri: 'http://localhost:3000/callback',
  apiKeyPrefix: 'mcid_live_abc',
  apiKeyCreatedAt: '2026-10-01T00:00:00.000Z',
  isActive: true,
  isKeyRevoked: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

export const inboundWebhook = {
  id: WEBHOOK_ID,
  name: 'Contact form',
  slug: 'contact-form',
  projectId: PROJECT_ID,
};

/**
 * The routes every resolver needs (server/project/webhook/member lookups),
 * overridable per test. `overrides` keys win over the base routes.
 */
export function baseRoutes(
  overrides: Record<string, RouteHandler> = {},
): Record<string, RouteHandler> {
  const base: Record<string, RouteHandler> = {
    'GET /servers': () => json([mainServer, otherServer]),
    'GET /admin/projects': () => json([projectRecord]),
    'GET /admin/inbound-webhooks': () => json([inboundWebhook]),
    'GET /admin/members': () => json({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
  };
  return { ...base, ...overrides };
}

/** ChannelListResponseDto from apps/api channels DTOs. */
export const channelList = {
  channels: [
    {
      id: CHANNEL_ID,
      name: 'general',
      type: 'text',
      position: 0,
      parentId: CATEGORY_ID,
      topic: null,
      nsfw: false,
      permissionOverwrites: false,
      lastMessageId: null,
      createdAt: '2026-01-15T14:30:00.000Z',
    },
    {
      id: CATEGORY_ID,
      name: 'Text Channels',
      type: 'category',
      position: 0,
      parentId: null,
      topic: null,
      nsfw: false,
      permissionOverwrites: false,
      createdAt: '2026-01-15T14:30:00.000Z',
    },
  ],
  categories: [{ id: CATEGORY_ID, name: 'Text Channels', position: 0, children: [CHANNEL_ID] }],
};

/** GetMessagesResponseDto: messages carry `timestamp`, response carries `hasMore`. */
export const messagePage = {
  messages: [
    {
      id: '999999999999999999',
      content: 'Hello from the test',
      author: { id: MEMBER_ID, username: 'john_doe', avatar: null },
      timestamp: '2026-10-23T09:00:00.000Z',
      embeds: [],
      attachments: [],
      mentions: [],
    },
  ],
  hasMore: false,
};
