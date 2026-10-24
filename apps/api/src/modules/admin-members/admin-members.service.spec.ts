import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdminMembersService } from './admin-members.service';
import { AdminMembersRepository } from './admin-members.repository';

describe('AdminMembersService', () => {
  let service: AdminMembersService;
  let repository: jest.Mocked<AdminMembersRepository>;

  beforeEach(async () => {
    const mockRepository: Partial<jest.Mocked<AdminMembersRepository>> = {
      findMemberById: jest.fn(),
      findMembershipsByMemberId: jest.fn(),
      findRolesByMemberId: jest.fn(),
      countMembers: jest.fn(),
      findMembersPaginated: jest.fn(),
      findMembershipsByMemberIds: jest.fn(),
      findRoleNamesByMemberIds: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminMembersService,
        { provide: AdminMembersRepository, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<AdminMembersService>(AdminMembersService);
    repository = module.get(AdminMembersRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getMemberCrossServerView', () => {
    it('should throw NotFoundException when member does not exist', async () => {
      repository.findMemberById.mockResolvedValue(null);

      await expect(
        service.getMemberCrossServerView('unknown-id'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return cross-server view for existing member', async () => {
      const member = {
        id: '123',
        username: 'testuser',
        globalName: 'Test User',
        displayName: 'Test',
        avatar: 'avatar-hash',
        isClubMember: true,
        syncedAt: new Date(),
      };

      const memberships = [
        {
          memberId: '123',
          serverId: 's1',
          joinedAt: new Date('2025-01-01'),
          serverName: 'Main Server',
          serverIcon: null,
          isMainServer: true,
        },
      ];

      const roles = [
        {
          roleId: 'r1',
          roleName: 'Admin',
          roleColor: 0xff0000,
          rolePosition: 10,
          serverId: 's1',
        },
      ];

      repository.findMemberById.mockResolvedValue(member);
      repository.findMembershipsByMemberId.mockResolvedValue(memberships);
      repository.findRolesByMemberId.mockResolvedValue(roles);

      const result = await service.getMemberCrossServerView('123');

      expect(result.memberId).toBe('123');
      expect(result.username).toBe('testuser');
      expect(result.isClubMember).toBe(true);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].serverId).toBe('s1');
      expect(result.servers[0].roles).toHaveLength(1);
      expect(result.servers[0].roles[0].name).toBe('Admin');
    });
  });

  describe('getCrossServerList', () => {
    it('should return empty data when no members match', async () => {
      repository.countMembers.mockResolvedValue(0);
      repository.findMembersPaginated.mockResolvedValue([]);

      const result = await service.getCrossServerList({
        filter: 'all',
        page: 1,
        limit: 20,
      });

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('should return paginated cross-server list', async () => {
      repository.countMembers.mockResolvedValue(1);
      repository.findMembersPaginated.mockResolvedValue([
        { id: '123', username: 'testuser', globalName: 'Test', avatar: null },
      ]);
      repository.findMembershipsByMemberIds.mockResolvedValue([
        {
          memberId: '123',
          serverId: 's1',
          joinedAt: new Date('2025-01-01'),
          serverName: 'Main Server',
          isMainServer: true,
        },
      ]);
      repository.findRoleNamesByMemberIds.mockResolvedValue([
        { memberId: '123', serverId: 's1', roleName: 'Admin' },
      ]);

      const result = await service.getCrossServerList({
        filter: 'all',
        page: 1,
        limit: 20,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].memberId).toBe('123');
      expect(result.data[0].isClubMember).toBe(true);
      expect(result.data[0].servers[0].roleNames).toContain('Admin');
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should pass serverId, roleId, and search to repository', async () => {
      repository.countMembers.mockResolvedValue(1);
      repository.findMembersPaginated.mockResolvedValue([
        { id: '123', username: 'testuser', globalName: 'Test', avatar: null },
      ]);
      repository.findMembershipsByMemberIds.mockResolvedValue([
        {
          memberId: '123',
          serverId: 's1',
          joinedAt: new Date('2025-01-01'),
          serverName: 'Main Server',
          isMainServer: true,
        },
      ]);
      repository.findRoleNamesByMemberIds.mockResolvedValue([
        { memberId: '123', serverId: 's1', roleName: 'Admin' },
      ]);

      const result = await service.getCrossServerList({
        filter: 'all',
        serverId: ['s1', 's2'],
        roleId: ['r1', 'r2'],
        search: 'test',
        page: 1,
        limit: 20,
      });

      expect(repository.countMembers).toHaveBeenCalledWith(
        'all',
        'test',
        ['s1', 's2'],
        ['r1', 'r2'],
        undefined,
      );
      expect(repository.findMembersPaginated).toHaveBeenCalledWith(
        'all',
        'test',
        20,
        0,
        ['s1', 's2'],
        ['r1', 'r2'],
        undefined,
      );
      expect(result.data).toHaveLength(1);
    });
  });

  // ── getExportData ─────────────────────────────────────────────────────

  describe('getExportData', () => {
    beforeEach(() => {
      repository.countMembers.mockResolvedValue(1);
      repository.findMembersPaginated.mockResolvedValue([
        { id: '123', username: 'alice', globalName: null, avatar: null },
      ]);
      repository.findMembershipsByMemberIds.mockResolvedValue([
        {
          memberId: '123',
          serverId: 's1',
          joinedAt: new Date('2025-01-01'),
          serverName: 'Main',
          isMainServer: true,
        },
        {
          memberId: '123',
          serverId: 's2',
          joinedAt: new Date('2025-01-02'),
          serverName: 'Secondary',
          isMainServer: false,
        },
      ]);
      repository.findRoleNamesByMemberIds.mockResolvedValue([]);
    });

    it('flattens cross-server list into rows for CSV export (filter=club)', async () => {
      const rows = await service.getExportData('club');
      expect(Array.isArray(rows)).toBe(true);
      expect(rows[0]).toHaveProperty('discord_id', '123');
      expect(rows[0]).toHaveProperty('server_name', 'Main');
    });

    it('flattens cross-server list into rows for CSV export (filter=all)', async () => {
      const rows = await service.getExportData('all');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveProperty('username', 'alice');
    });

    it('filters rows to specific serverId when serverId is provided in ExportQueryDto', async () => {
      const rows = await service.getExportData({
        filter: 'all',
        serverId: ['s1'],
        format: 'csv',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveProperty('server_id', 's1');
    });

    it('filters rows to matching serverIds when multiple serverIds are provided', async () => {
      const rows = await service.getExportData({
        filter: 'all',
        serverId: ['s1', 's2'],
        format: 'json',
      });
      expect(rows).toHaveLength(2);
    });
  });
});
