import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { QueryAuditLogsDto } from './query-audit-logs.dto';

describe('QueryAuditLogsDto actionType', () => {
  it('accepts the access category that grant edits and sync write', () => {
    const dto = plainToInstance(QueryAuditLogsDto, { actionType: 'access' });
    const errors = validateSync(dto);
    expect(errors).toHaveLength(0);
    expect(dto.actionType).toBe('access');
  });

  it('still rejects unknown categories', () => {
    const dto = plainToInstance(QueryAuditLogsDto, { actionType: 'nonsense' });
    const errors = validateSync(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
