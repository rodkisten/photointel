import { describe, it, expect } from 'vitest';
import { 
  number, 
  date, 
  bytes, 
  text, 
  isPlainObject, 
  obj, 
  items, 
  isStatusKey, 
  statusLabel,
  FORMAT_CONFIG,
  STATUS_MAPPING
} from './formatters'; // Adjust the import path as needed

describe('Data Formatting & Extraction Utilities', () => {

  describe('number()', () => {
    it('formats valid numbers with pt-BR locale', () => {
      expect(number(1234.56)).toBe('1.234,56');
      expect(number(0)).toBe('0');
      expect(number(-42.1)).toBe('-42,1');
    });

    it('returns fallback for non-number values', () => {
      expect(number('123')).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
      expect(number(null)).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
      expect(number(undefined)).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
      expect(number({})).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
    });
  });

  describe('date()', () => {
    it('returns fallback for empty or non-string values', () => {
      expect(date('')).toBe(FORMAT_CONFIG.FALLBACK_UNREGISTERED);
      expect(date('   ')).toBe(FORMAT_CONFIG.FALLBACK_UNREGISTERED);
      expect(date(null)).toBe(FORMAT_CONFIG.FALLBACK_UNREGISTERED);
    });

    it('returns the raw string if date parsing fails', () => {
      expect(date('not-a-valid-date')).toBe('not-a-valid-date');
    });

    it('formats a valid ISO date string correctly (Date Only)', () => {
      // Using a fixed date: January 15, 2026
      const rawDate = '2026-01-15T12:00:00Z';
      const formatted = date(rawDate);
      
      // We expect the pt-BR 'long' format string to contain these elements
      expect(formatted).toContain('15 de janeiro de 2026');
    });

    it('formats a valid ISO date string correctly (Date & Time)', () => {
      const rawDate = '2026-01-15T15:30:00Z';
      const formatted = date(rawDate, true);
      
      // Medium date format usually looks like "15 de jan. de 2026" and time "12:30"
      expect(formatted).toMatch(/15 de jan\.? de 2026/);
      expect(formatted).toMatch(/\d{2}:\d{2}/); // Matches time signature
    });
  });

  describe('bytes()', () => {
    it('formats bytes correctly within standard thresholds', () => {
      expect(bytes(500)).toBe('500 B');
      expect(bytes(1024)).toBe('1 KB');
      expect(bytes(1536)).toBe('1,5 KB'); // 1.5 * 1024
      expect(bytes(1048576)).toBe('1 MB'); // 1024 * 1024
      expect(bytes(1073741824)).toBe('1 GB');
      expect(bytes(1099511627776)).toBe('1 TB');
    });

    it('caps the unit to TB even for extremely large numbers', () => {
      const massiveNumber = 1024 ** 5; // PB (Petabytes)
      // Since we capped at TB (index 4), it should format as a large TB amount
      expect(bytes(massiveNumber)).toBe('1.024 TB');
    });

    it('returns fallback for non-number values', () => {
      expect(bytes('1024')).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
      expect(bytes(null)).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
    });
  });

  describe('text()', () => {
    it('returns fallback for null or undefined', () => {
      expect(text(null)).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
      expect(text(undefined)).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
    });

    it('stringifies objects and arrays', () => {
      expect(text({ a: 1 })).toBe('{"a":1}');
      expect(text([1, 2])).toBe('[1,2]');
    });

    it('casts standard primitives to string', () => {
      expect(text('hello')).toBe('hello');
      expect(text(123)).toBe('123');
      expect(text(true)).toBe('true');
    });
  });

  describe('isPlainObject() & obj()', () => {
    it('identifies plain objects securely', () => {
      expect(isPlainObject({ key: 'value' })).toBe(true);
      
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject([1, 2, 3])).toBe(false);
      expect(isPlainObject('string')).toBe(false);
      expect(isPlainObject(123)).toBe(false);
    });

    it('obj() extracts the object or returns an empty fallback', () => {
      expect(obj({ name: 'Alice' })).toEqual({ name: 'Alice' });
      expect(obj(['an', 'array'])).toEqual({});
      expect(obj(null)).toEqual({});
    });
  });

  describe('items()', () => {
    it('maps an array of mixed types to an array of safe objects', () => {
      const rawArray = [
        { id: 1 }, 
        null, 
        'invalid_string', 
        { id: 2 }, 
        [1, 2]
      ];
      
      const result = items(rawArray);
      
      expect(result).toEqual([
        { id: 1 },
        {}, // null becomes empty object
        {}, // string becomes empty object
        { id: 2 },
        {}  // array becomes empty object
      ]);
    });

    it('returns an empty array if the root value is not an array', () => {
      expect(items({ not: 'an_array' })).toEqual([]);
      expect(items(null)).toEqual([]);
    });
  });

  describe('isStatusKey() & statusLabel()', () => {
    it('identifies valid status keys mapped in STATUS_MAPPING', () => {
      expect(isStatusKey('queued')).toBe(true);
      expect(isStatusKey('completed')).toBe(true);
      
      expect(isStatusKey('fake_status_key')).toBe(false);
      // @ts-expect-error - Testing runtime safety against wrong types
      expect(isStatusKey(123)).toBe(false);
    });

    it('returns the localized label for a known status', () => {
      expect(statusLabel('queued')).toBe(STATUS_MAPPING.queued);
      expect(statusLabel('failed')).toBe(STATUS_MAPPING.failed);
    });

    it('returns the raw text fallback for unknown statuses', () => {
      expect(statusLabel('new_unmapped_status')).toBe('new_unmapped_status');
    });

    it('gracefully handles non-string inputs using text() fallback', () => {
      expect(statusLabel(null)).toBe(FORMAT_CONFIG.FALLBACK_EMPTY);
      expect(statusLabel({ custom: 'status' })).toBe('{"custom":"status"}');
    });
  });

});
