import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { AdminAccessGuard } from '../../common/guards/admin-access.guard';

const mockSyncService = {
  triggerMultipleSyncs: jest.fn(),
  getSyncStatus: jest.fn(),
  getAllServersSyncStatus: jest.fn(),
  getSyncLogs: jest.fn(),
  getSyncChangeDetails: jest.fn(),
};

describe('SyncController', () => {
  let controller: SyncController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [{ provide: SyncService, useValue: mockSyncService }],
    })
      .overrideGuard(AdminAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(SyncController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── triggerFullSync ─────────────────────────────────────────────────

  describe('triggerFullSync', () => {
    it('passes serverIds from dto to service', async () => {
      mockSyncService.triggerMultipleSyncs.mockResolvedValue({ syncs: [] });
      await controller.triggerFullSync({
        serverIds: ['s1', 's2'],
        target: 'ALL',
      } as any);
      expect(mockSyncService.triggerMultipleSyncs).toHaveBeenCalledWith(
        ['s1', 's2'],
        'ALL',
      );
    });

    it('passes empty array when serverIds not provided', async () => {
      mockSyncService.triggerMultipleSyncs.mockResolvedValue({ syncs: [] });
      await controller.triggerFullSync({ target: 'ALL' } as any);
      expect(mockSyncService.triggerMultipleSyncs).toHaveBeenCalledWith(
        [],
        'ALL',
      );
    });
  });

  // ── getSyncStatus ───────────────────────────────────────────────────

  describe('getSyncStatus', () => {
    it('returns status from service', async () => {
      const status = { syncId: 1, status: 'COMPLETED' };
      mockSyncService.getSyncStatus.mockResolvedValue(status);
      const result = await controller.getSyncStatus('s1');
      expect(result).toEqual(status);
    });

    it('throws NotFoundException when service returns null', async () => {
      mockSyncService.getSyncStatus.mockResolvedValue(null);
      await expect(controller.getSyncStatus('s1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── getAllServersSyncStatus ─────────────────────────────────────────

  it('getAllServersSyncStatus returns array from service', async () => {
    mockSyncService.getAllServersSyncStatus.mockResolvedValue([]);
    const result = await controller.getAllServersSyncStatus();
    expect(Array.isArray(result)).toBe(true);
  });

  // ── getSyncLogs ─────────────────────────────────────────────────────

  it('getSyncLogs delegates query to service', async () => {
    mockSyncService.getSyncLogs.mockResolvedValue({ logs: [], total: 0 });
    await controller.getSyncLogs({
      serverId: 's1',
      limit: 10,
      offset: 0,
    } as any);
    expect(mockSyncService.getSyncLogs).toHaveBeenCalledWith('s1', 10, 0);
  });

  // ── getSyncChangeDetails ────────────────────────────────────────────

  it('getSyncChangeDetails passes syncLogId and pagination to service', async () => {
    mockSyncService.getSyncChangeDetails.mockResolvedValue({
      changes: [],
      total: 0,
    });
    await controller.getSyncChangeDetails(42, 50, 10);
    expect(mockSyncService.getSyncChangeDetails).toHaveBeenCalledWith(
      42,
      50,
      10,
    );
  });

  it('getSyncChangeDetails forwards the action filter to the service', async () => {
    mockSyncService.getSyncChangeDetails.mockResolvedValue({
      changes: [],
      total: 0,
    });
    await controller.getSyncChangeDetails(42, 50, 10, 'added');
    expect(mockSyncService.getSyncChangeDetails).toHaveBeenCalledWith(
      42,
      50,
      10,
      'added',
    );
  });
});
