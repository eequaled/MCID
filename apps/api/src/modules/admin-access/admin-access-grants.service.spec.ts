import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { PermissionCacheService } from '../permissions/permission-cache.service';
import { AdminAccessGrantsService } from './admin-access-grants.service';
import { AdminAccessRepository } from './admin-access.repository';
import { AdminAccessService } from './admin-access.service';

describe('AdminAccessGrantsService', () => {
  let service: AdminAccessGrantsService;
  const repo = {
    findMainServerId: jest.fn(),
    findRole: jest.fn(),
    listServerRoles: jest.fn(),
    findGrantsForRoles: jest.fn(),
    findMemberOverrides: jest.fn(),
    memberExists: jest.fn(),
    findMemberProfile: jest.fn(),
    listOverrideRows: jest.fn(),
    replaceRoleGrants: jest.fn(),
    replaceMemberOverrides: jest.fn(),
    deleteMemberOverride: jest.fn(),
  };
  const access = { isRootRole: jest.fn(), getEffectiveAccess: jest.fn() };
  const cache = {
    invalidateAllAdminAccess: jest.fn(),
    invalidateMember: jest.fn(),
  };
  const audit = { logAction: jest.fn() };
  const client = { ipAddress: '203.0.113.7', userAgent: 'jest' };

  beforeEach(async () => {
    jest.resetAllMocks();
    repo.findMainServerId.mockResolvedValue('main');
    repo.findRole.mockResolvedValue({
      id: 'role-hr',
      serverId: 'main',
      name: 'HR',
    });
    repo.findGrantsForRoles.mockResolvedValue([]);
    repo.findMemberOverrides.mockResolvedValue([]);
    repo.memberExists.mockResolvedValue(true);
    repo.findMemberProfile.mockResolvedValue({
      id: 'member-9',
      username: 'ada',
      globalName: 'Ada G',
      displayName: null,
      avatar: 'https://cdn.example/ada.png',
    });
    repo.listOverrideRows.mockResolvedValue([]);
    access.isRootRole.mockReturnValue(false);
    access.getEffectiveAccess.mockResolvedValue({ root: false, access: {} });

    const module = await Test.createTestingModule({
      providers: [
        AdminAccessGrantsService,
        { provide: AdminAccessRepository, useValue: repo },
        { provide: AdminAccessService, useValue: access },
        { provide: PermissionCacheService, useValue: cache },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(AdminAccessGrantsService);
  });

  describe('getCatalog', () => {
    it('lists every resource and level with a description', () => {
      const catalog = service.getCatalog();
      expect(catalog.resources).toHaveLength(14);
      expect(catalog.resources[0]).toEqual({
        key: 'servers',
        description: expect.any(String),
      });
      expect(catalog.levels.map((l) => l.key)).toEqual([
        'none',
        'read',
        'write',
        'manage',
      ]);
    });
  });

  describe('listRoles', () => {
    it('returns the main-server roles with their grants and a root flag', async () => {
      repo.listServerRoles.mockResolvedValue([
        { id: 'role-hr', name: 'HR', position: 3 },
        { id: 'role-exec', name: 'Executive', position: 9 },
      ]);
      repo.findGrantsForRoles.mockResolvedValue([
        { roleId: 'role-hr', resource: 'members', level: 'read' },
      ]);
      access.isRootRole.mockImplementation((id: string) => id === 'role-exec');

      const roles = await service.listRoles();

      expect(roles).toEqual([
        {
          id: 'role-hr',
          name: 'HR',
          position: 3,
          root: false,
          grants: { members: 'read' },
        },
        {
          id: 'role-exec',
          name: 'Executive',
          position: 9,
          root: true,
          grants: {},
        },
      ]);
    });
  });

  describe('setRoleGrants', () => {
    it('stores the grants, drops none, clears every cached admin entry and audits before and after', async () => {
      repo.findGrantsForRoles.mockResolvedValue([
        { roleId: 'role-hr', resource: 'audit', level: 'read' },
      ]);

      const result = await service.setRoleGrants(
        'actor-1',
        'role-hr',
        { members: 'read', audit: 'none', projects: 'write' },
        client,
      );

      expect(repo.replaceRoleGrants).toHaveBeenCalledWith(
        'role-hr',
        [
          { resource: 'members', level: 'read' },
          { resource: 'projects', level: 'write' },
        ],
        'actor-1',
      );
      expect(cache.invalidateAllAdminAccess).toHaveBeenCalled();
      expect(audit.logAction).toHaveBeenCalledWith({
        actorId: 'actor-1',
        actionType: 'access',
        action: 'role_grants_updated',
        entityType: 'role',
        entityId: 'role-hr',
        details: {
          before: { audit: 'read' },
          after: { members: 'read', projects: 'write' },
        },
        ipAddress: '203.0.113.7',
        userAgent: 'jest',
        severity: 'info',
      });
      expect(result).toEqual({
        roleId: 'role-hr',
        grants: { members: 'read', projects: 'write' },
      });
    });

    it('rejects an unknown resource and an unknown level with 400', async () => {
      await expect(
        service.setRoleGrants('a', 'role-hr', { nope: 'read' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.setRoleGrants('a', 'role-hr', { members: 'admin' }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.replaceRoleGrants).not.toHaveBeenCalled();
    });

    it('returns 404 for a role that does not exist or belongs to another server', async () => {
      repo.findRole.mockResolvedValue(null);
      await expect(
        service.setRoleGrants('a', 'ghost', { members: 'read' }),
      ).rejects.toThrow(NotFoundException);

      repo.findRole.mockResolvedValue({
        id: 'r',
        serverId: 'other',
        name: 'x',
      });
      await expect(
        service.setRoleGrants('a', 'r', { members: 'read' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses to give grants to a root role', async () => {
      access.isRootRole.mockReturnValue(true);
      await expect(
        service.setRoleGrants('a', 'role-hr', { members: 'read' }),
      ).rejects.toThrow(
        'Root roles hold full access and cannot be given grants',
      );
      expect(repo.replaceRoleGrants).not.toHaveBeenCalled();
    });
  });

  describe('member overrides', () => {
    it('stores overrides including none, clears that member and audits', async () => {
      repo.findMemberOverrides.mockResolvedValue([
        { resource: 'stats', level: 'read' },
      ]);

      const result = await service.setMemberOverrides(
        'actor-1',
        'member-9',
        { messages: 'none', projects: 'manage' },
        client,
      );

      expect(repo.replaceMemberOverrides).toHaveBeenCalledWith(
        'member-9',
        [
          { resource: 'messages', level: 'none' },
          { resource: 'projects', level: 'manage' },
        ],
        'actor-1',
      );
      expect(cache.invalidateMember).toHaveBeenCalledWith('member-9');
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'member_overrides_updated',
          entityType: 'member',
          entityId: 'member-9',
          details: {
            before: { stats: 'read' },
            after: { messages: 'none', projects: 'manage' },
          },
        }),
      );
      expect(result).toEqual({
        memberId: 'member-9',
        overrides: { messages: 'none', projects: 'manage' },
      });
    });

    it('returns 404 for an unknown member', async () => {
      repo.memberExists.mockResolvedValue(false);
      await expect(
        service.setMemberOverrides('a', 'ghost', { members: 'read' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses overrides on a member who currently holds a root role', async () => {
      access.getEffectiveAccess.mockResolvedValue({ root: true, access: {} });
      await expect(
        service.setMemberOverrides('a', 'member-9', { members: 'none' }),
      ).rejects.toThrow(
        'Root admins hold full access and cannot be given overrides',
      );
      expect(repo.replaceMemberOverrides).not.toHaveBeenCalled();
    });

    it('removes one override, clears the member and audits', async () => {
      repo.deleteMemberOverride.mockResolvedValue(true);

      await service.removeMemberOverride(
        'actor-1',
        'member-9',
        'messages',
        client,
      );

      expect(repo.deleteMemberOverride).toHaveBeenCalledWith(
        'member-9',
        'messages',
      );
      expect(cache.invalidateMember).toHaveBeenCalledWith('member-9');
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'member_override_removed',
          entityId: 'member-9',
        }),
      );
    });

    it('returns 404 when there is no override to remove, and 400 for an unknown resource', async () => {
      repo.deleteMemberOverride.mockResolvedValue(false);
      await expect(
        service.removeMemberOverride('a', 'member-9', 'messages'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.removeMemberOverride('a', 'member-9', 'nope'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getMemberEffective', () => {
    it('returns the member profile and the resolved level with its source per resource', async () => {
      const resolved = {
        root: false,
        access: {
          members: {
            level: 'read',
            source: { type: 'role', roleId: 'role-hr' },
          },
        },
      };
      access.getEffectiveAccess.mockResolvedValue(resolved);

      await expect(service.getMemberEffective('member-9')).resolves.toEqual({
        memberId: 'member-9',
        username: 'ada',
        displayName: 'Ada G',
        avatar: 'https://cdn.example/ada.png',
        ...resolved,
      });
    });

    it('returns 404 for an unknown member', async () => {
      repo.findMemberProfile.mockResolvedValue(null);
      await expect(service.getMemberEffective('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listMemberOverrides', () => {
    const row = (
      memberId: string,
      resource: string,
      level: string,
      name: string,
    ) => ({
      memberId,
      resource,
      level,
      username: name.toLowerCase(),
      globalName: null,
      displayName: name,
      avatar: null,
    });

    it('groups the rows by member, sorts by name and flags members who are root now', async () => {
      repo.listOverrideRows.mockResolvedValue([
        row('m2', 'messages', 'none', 'Zed'),
        row('m1', 'projects', 'manage', 'Ada'),
        row('m1', 'stats', 'read', 'Ada'),
      ]);
      access.getEffectiveAccess.mockImplementation((id: string) =>
        Promise.resolve({ root: id === 'm2', access: {} }),
      );

      const result = await service.listMemberOverrides();

      expect(result).toEqual({
        members: [
          {
            memberId: 'm1',
            username: 'ada',
            displayName: 'Ada',
            avatar: null,
            root: false,
            overrides: { projects: 'manage', stats: 'read' },
          },
          {
            memberId: 'm2',
            username: 'zed',
            displayName: 'Zed',
            avatar: null,
            root: true,
            overrides: { messages: 'none' },
          },
        ],
      });
    });

    it('is empty when nobody has an override', async () => {
      await expect(service.listMemberOverrides()).resolves.toEqual({
        members: [],
      });
    });
  });
});
