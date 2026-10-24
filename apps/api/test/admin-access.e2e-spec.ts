/**
 * E2E: admin access levels (/api/admin/access/*, and enforcement on admin routes).
 *
 * Requires a running PostgreSQL database (`DATABASE_URL`) and Redis.
 * Root is the Executive role seeded by `seedAdminContext`
 * (MC_EXECUTIVE_ROLE_ID is set in `createTestApp`).
 */
import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createTestApp } from './helpers/create-app';
import {
  AdminContext,
  MemberContext,
  clearAllTables,
  closeTestDb,
  getTestDb,
  seedAdminContext,
  seedNonRootMember,
  TestDb,
} from './helpers/db';
import { disableNock, enableNock } from './helpers/discord-mock';
import { PermissionCacheService } from '../src/modules/permissions/permission-cache.service';
import { adminMemberAccess, auditLogs } from '../src/database/entities';

const DB_URL = process.env.DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

describeIf('/api/admin/access and level enforcement (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let root: AdminContext;
  let dev: MemberContext;

  beforeAll(async () => {
    enableNock();
    db = getTestDb();
    app = await createTestApp();
  });

  afterAll(async () => {
    disableNock();
    await closeTestDb();
    await app.close();
  });

  beforeEach(async () => {
    await clearAllTables(db);
    // Admin access is cached in Redis, which clearAllTables does not touch.
    await app.get(PermissionCacheService).clear();
    root = await seedAdminContext(db);
    dev = await seedNonRootMember(db, root.serverId);
  });

  const as = (token: string) => `Bearer ${token}`;
  const http = () => request(app.getHttpServer());

  const grantRole = (grants: Record<string, string>) =>
    http()
      .put(`/api/admin/access/roles/${dev.roleId}`)
      .set('Authorization', as(root.bearerToken))
      .send({ grants })
      .expect(200);

  it('lets a member with no grant sign in to /auth/admin/me but nothing else', async () => {
    const me = await http()
      .get('/api/auth/admin/me')
      .set('Authorization', as(dev.bearerToken))
      .expect(200);
    expect(me.body.root).toBe(false);
    expect(me.body.permissions.members).toBe('none');

    await http()
      .get('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .expect(403);
  });

  it('reports root and manage everywhere for a root admin', async () => {
    const me = await http()
      .get('/api/auth/admin/me')
      .set('Authorization', as(root.bearerToken))
      .expect(200);
    expect(me.body.root).toBe(true);
    expect(me.body.permissions.settings).toBe('manage');
  });

  it('enforces read, write and manage on the settings endpoints, cumulatively', async () => {
    await grantRole({ settings: 'read' });
    await http()
      .get('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .expect(200);
    await http()
      .patch('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .send({ cache: { permissionTtlMs: 900_000 } })
      .expect(403);

    await grantRole({ settings: 'write' });
    await http()
      .get('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .expect(200);
    await http()
      .patch('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .send({ cache: { permissionTtlMs: 900_000 } })
      .expect(200);
    await http()
      .post('/api/admin/settings/reset')
      .set('Authorization', as(dev.bearerToken))
      .expect(403);

    await grantRole({ settings: 'manage' });
    await http()
      .post('/api/admin/settings/reset')
      .set('Authorization', as(dev.bearerToken))
      .expect(200);
  });

  it('applies a grant change on the very next request', async () => {
    await http()
      .get('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .expect(403);
    await grantRole({ settings: 'read' });
    await http()
      .get('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .expect(200);
    await grantRole({});
    await http()
      .get('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .expect(403);
  });

  it('lets a member override raise, lower and deny relative to the role', async () => {
    await grantRole({ settings: 'read' });

    await http()
      .put(`/api/admin/access/members/${dev.memberId}`)
      .set('Authorization', as(root.bearerToken))
      .send({ grants: { settings: 'manage' } })
      .expect(200);
    await http()
      .post('/api/admin/settings/reset')
      .set('Authorization', as(dev.bearerToken))
      .expect(200);

    await http()
      .put(`/api/admin/access/members/${dev.memberId}`)
      .set('Authorization', as(root.bearerToken))
      .send({ grants: { settings: 'none' } })
      .expect(200);
    await http()
      .get('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .expect(403);

    await http()
      .delete(`/api/admin/access/members/${dev.memberId}/settings`)
      .set('Authorization', as(root.bearerToken))
      .expect(204);
    await http()
      .get('/api/admin/settings')
      .set('Authorization', as(dev.bearerToken))
      .expect(200);
  });

  it('explains where an effective level comes from', async () => {
    await grantRole({ members: 'read' });

    const res = await http()
      .get(`/api/admin/access/members/${dev.memberId}/effective`)
      .set('Authorization', as(root.bearerToken))
      .expect(200);

    expect(res.body.root).toBe(false);
    expect(res.body.access.members).toEqual({
      level: 'read',
      source: { type: 'role', roleId: dev.roleId },
    });
  });

  it('keeps grant management root-only, even for a member with manage on everything', async () => {
    await grantRole(
      Object.fromEntries(
        [
          'servers',
          'members',
          'channels',
          'messages',
          'roles',
          'projects',
          'project_keys',
          'webhooks',
          'inbound_webhooks',
          'sync',
          'stats',
          'audit',
          'monitoring',
          'settings',
        ].map((r) => [r, 'manage']),
      ),
    );

    await http()
      .get('/api/admin/access/catalog')
      .set('Authorization', as(dev.bearerToken))
      .expect(403);
    await http()
      .put(`/api/admin/access/roles/${dev.roleId}`)
      .set('Authorization', as(dev.bearerToken))
      .send({ grants: {} })
      .expect(403);
  });

  it('locks root: no grants on a root role, no overrides on a root member', async () => {
    await http()
      .put(`/api/admin/access/roles/${root.roleId}`)
      .set('Authorization', as(root.bearerToken))
      .send({ grants: { members: 'read' } })
      .expect(400);
    await http()
      .put(`/api/admin/access/members/${root.memberId}`)
      .set('Authorization', as(root.bearerToken))
      .send({ grants: { members: 'none' } })
      .expect(400);
  });

  it('rejects unknown resources and levels with 400', async () => {
    await http()
      .put(`/api/admin/access/roles/${dev.roleId}`)
      .set('Authorization', as(root.bearerToken))
      .send({ grants: { nope: 'read' } })
      .expect(400);
    await http()
      .put(`/api/admin/access/roles/${dev.roleId}`)
      .set('Authorization', as(root.bearerToken))
      .send({ grants: { members: 'admin' } })
      .expect(400);
  });

  it('writes an audit row with the grants before and after', async () => {
    await grantRole({ members: 'read' });
    await grantRole({ members: 'write', audit: 'read' });
    // logAction is fire and forget
    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actionType, 'access'));

    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(
      expect.objectContaining({
        action: 'role_grants_updated',
        actorId: root.memberId,
        entityId: dev.roleId,
        details: {
          before: { members: 'read' },
          after: { members: 'write', audit: 'read' },
        },
      }),
    );
  });

  it('refuses an unauthenticated request', async () => {
    await http().get('/api/admin/access/catalog').expect(401);
  });

  it('lists the members that have overrides, root only', async () => {
    await http()
      .put(`/api/admin/access/members/${dev.memberId}`)
      .set('Authorization', as(root.bearerToken))
      .send({ grants: { messages: 'none', projects: 'manage' } })
      .expect(200);

    const res = await http()
      .get('/api/admin/access/overrides')
      .set('Authorization', as(root.bearerToken))
      .expect(200);

    expect(res.body.members).toEqual([
      {
        memberId: dev.memberId,
        username: 'member2',
        displayName: 'Member 2',
        avatar: null,
        root: false,
        overrides: { messages: 'none', projects: 'manage' },
      },
    ]);

    await http()
      .get('/api/admin/access/overrides')
      .set('Authorization', as(dev.bearerToken))
      .expect(403);
  });

  it('flags a member whose overrides are inactive because they are root now', async () => {
    // A row left over from before the member became root: the API would refuse to write it today.
    await db.insert(adminMemberAccess).values({
      memberId: root.memberId,
      resource: 'messages',
      level: 'none',
    });

    const res = await http()
      .get('/api/admin/access/overrides')
      .set('Authorization', as(root.bearerToken))
      .expect(200);

    expect(res.body.members).toEqual([
      expect.objectContaining({
        memberId: root.memberId,
        root: true,
        overrides: { messages: 'none' },
      }),
    ]);
  });

  it('returns the member profile with the effective access, and 404 for an unknown member', async () => {
    const res = await http()
      .get(`/api/admin/access/members/${dev.memberId}/effective`)
      .set('Authorization', as(root.bearerToken))
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        memberId: dev.memberId,
        username: 'member2',
        displayName: 'Member 2',
        root: false,
      }),
    );

    await http()
      .get('/api/admin/access/members/999999999999999999/effective')
      .set('Authorization', as(root.bearerToken))
      .expect(404);
  });
});
