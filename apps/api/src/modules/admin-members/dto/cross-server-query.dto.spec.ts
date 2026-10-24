import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CrossServerQueryDto,
  ExportQueryDto,
  toStringArray,
} from './cross-server-query.dto';

describe('CrossServerQueryDto & toStringArray', () => {
  describe('toStringArray helper', () => {
    it('returns undefined for null or undefined', () => {
      expect(toStringArray(null)).toBeUndefined();
      expect(toStringArray(undefined)).toBeUndefined();
    });

    it('transforms a single string into a single-element array', () => {
      expect(toStringArray('123456')).toEqual(['123456']);
    });

    it('trims whitespace and ignores empty string', () => {
      expect(toStringArray('   ')).toBeUndefined();
      expect(toStringArray('  123456  ')).toEqual(['123456']);
    });

    it('transforms a comma-separated string into multiple elements', () => {
      expect(toStringArray('111,222, 333')).toEqual(['111', '222', '333']);
    });

    it('transforms an array of strings', () => {
      expect(toStringArray(['111', '222', '333'])).toEqual([
        '111',
        '222',
        '333',
      ]);
    });

    it('handles comma-separated strings inside an array', () => {
      expect(toStringArray(['111,222', '333', '444, 555'])).toEqual([
        '111',
        '222',
        '333',
        '444',
        '555',
      ]);
    });

    it('handles qs-collapsed plain objects (when 21+ query params exceed arrayLimit)', () => {
      const qsObject: Record<string, string> = {};
      for (let i = 0; i < 25; i++) {
        qsObject[i.toString()] = `server-${i}`;
      }

      const result = toStringArray(qsObject);
      expect(result).toHaveLength(25);
      expect(result?.[0]).toBe('server-0');
      expect(result?.[24]).toBe('server-24');
    });

    it('ignores non-string or empty elements inside arrays and objects', () => {
      expect(toStringArray([123, null, '', '  ', 'valid'])).toEqual(['valid']);
      expect(
        toStringArray({ a: 'valid', b: '', c: null, d: undefined }),
      ).toEqual(['valid']);
    });
  });

  describe('CrossServerQueryDto transform integration', () => {
    it('transforms repeated query params into array of strings', () => {
      const dto = plainToInstance(CrossServerQueryDto, {
        serverId: ['srv-1', 'srv-2'],
        roleId: ['role-1', 'role-2'],
      });

      expect(dto.serverId).toEqual(['srv-1', 'srv-2']);
      expect(dto.roleId).toEqual(['role-1', 'role-2']);
    });

    it('transforms single string query params into array of strings', () => {
      const dto = plainToInstance(CrossServerQueryDto, {
        serverId: 'srv-1',
        roleId: 'role-1',
      });

      expect(dto.serverId).toEqual(['srv-1']);
      expect(dto.roleId).toEqual(['role-1']);
    });

    it('transforms comma-separated string query params into array of strings', () => {
      const dto = plainToInstance(CrossServerQueryDto, {
        serverId: 'srv-1,srv-2',
        roleId: 'role-1,role-2',
      });

      expect(dto.serverId).toEqual(['srv-1', 'srv-2']);
      expect(dto.roleId).toEqual(['role-1', 'role-2']);
    });

    it('transforms qs-collapsed object (>20 params) into array of strings', () => {
      const serverIdObj: Record<string, string> = {};
      for (let i = 0; i < 22; i++) {
        serverIdObj[i.toString()] = `srv-${i}`;
      }

      const dto = plainToInstance(CrossServerQueryDto, {
        serverId: serverIdObj,
      });

      expect(dto.serverId).toHaveLength(22);
      expect(dto.serverId?.[0]).toBe('srv-0');
      expect(dto.serverId?.[21]).toBe('srv-21');
    });
  });

  describe('ExportQueryDto transform integration', () => {
    it('transforms multi-select serverId and roleId', () => {
      const dto = plainToInstance(ExportQueryDto, {
        serverId: ['srv-1', 'srv-2'],
        roleId: ['role-1', 'role-2'],
        format: 'csv',
      });

      expect(dto.serverId).toEqual(['srv-1', 'srv-2']);
      expect(dto.roleId).toEqual(['role-1', 'role-2']);
      expect(dto.format).toBe('csv');
    });
  });
});

describe('CrossServerQueryDto joinedAfter', () => {
  it('accepts an ISO date joinedAfter filter', () => {
    const dto = plainToInstance(CrossServerQueryDto, {
      joinedAfter: '2026-01-01T00:00:00Z',
    });
    const errors = validateSync(dto);
    expect(errors).toHaveLength(0);
    expect(dto.joinedAfter).toBe('2026-01-01T00:00:00Z');
  });

  it('validates joinedAfter as a date, so it is a declared query field', () => {
    const dto = plainToInstance(CrossServerQueryDto, {
      joinedAfter: 'not-a-date',
    });
    const errors = validateSync(dto);
    expect(errors.some((e) => e.property === 'joinedAfter')).toBe(true);
  });
});
