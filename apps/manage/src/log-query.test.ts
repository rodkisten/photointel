import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError } from './auth';
import { parseLogRequest, gcpLogFilter, TIME_MS, LOG_CONFIG } from './log-query';

// Shared test fixtures
const MOCK_NOW = Date.parse('2026-11-03T12:00:00.000Z');
const CORRELATION_ID = '4d0977df-e6c9-46a9-a8ea-5c5cca15778c';
const JOB_ID = '510e985c-fb17-4294-ac63-42b7ac1c1b3c';

describe('Log Query Utilities', () => {
  beforeEach(() => {
    // Lock the system time to ensure predictable timestamp calculations
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_NOW);
  });

  afterEach(() => {
    // Restore real time after each test
    vi.useRealTimers();
  });

  describe('parseLogRequest', () => {
    it('returns default values when no parameters are provided', () => {
      const params = new URLSearchParams();
      const request = parseLogRequest(params, MOCK_NOW);

      expect(request.minutes).toBe(LOG_CONFIG.DEFAULT_MINUTES);
      expect(request.start).toBe(MOCK_NOW - LOG_CONFIG.DEFAULT_MINUTES * TIME_MS.MINUTE);
      expect(request.end).toBe(MOCK_NOW);
      expect(request.terms).toEqual([]);
      expect(request.entry).toBe('');
    });

    it('does not allow query injection, invalid IDs or excessive windows', () => {
      const invalidParams = [
        new URLSearchParams({ correlation: 'hello" OR true', minutes: '30' }), // Injection attempt
        new URLSearchParams({ search: 'foo bar', minutes: '30' }),             // Invalid term format
        new URLSearchParams({ minutes: '999999' }),                            // Excessive window
        new URLSearchParams({ minutes: '2' }),                                 // Below minimum window
      ];

      for (const params of invalidParams) {
        expect(() => parseLogRequest(params, MOCK_NOW)).toThrow(ApiError);
      }
    });

    it('parses and deduplicates valid search terms', () => {
      const params = new URLSearchParams({
        correlation: CORRELATION_ID,
        job: CORRELATION_ID, // Duplicate value to test deduplication
        search: 'error-message',
      });
      
      const request = parseLogRequest(params, MOCK_NOW);
      expect(request.terms).toEqual([CORRELATION_ID, 'error-message']);
    });

    it('throws ApiError if "at" parameter is too far in the past', () => {
      // Event happened 10 days ago (max allowed is 7 days)
      const oldEvent = new Date(MOCK_NOW - 10 * TIME_MS.DAY).toISOString();
      const params = new URLSearchParams({ at: oldEvent });
      
      expect(() => parseLogRequest(params, MOCK_NOW)).toThrow(ApiError);
    });
  });

  describe('gcpLogFilter', () => {
    it('shows only warnings for the unfiltered general feed', () => {
      const request = parseLogRequest(new URLSearchParams({ minutes: '15' }), MOCK_NOW);
      const filter = gcpLogFilter(request);

      expect(filter).toContain('severity>=WARNING');
      expect(filter).not.toContain('SEARCH(');
      expect(filter).toContain('resource.type="cloud_run_job" OR resource.type="cloud_run_revision"');
    });

    it('builds an exact match query without severity threshold when entry ID is provided', () => {
      const request = parseLogRequest(new URLSearchParams({ entry: 'insert-9876', minutes: '15' }), MOCK_NOW);
      const filter = gcpLogFilter(request);

      expect(filter).toContain('insertId="insert-9876"');
      expect(filter).not.toContain('severity>=WARNING');
    });

    it('formats timestamp constraints correctly within the query', () => {
      const request = parseLogRequest(new URLSearchParams({ minutes: '60' }), MOCK_NOW);
      const filter = gcpLogFilter(request);
      
      const expectedStart = new Date(MOCK_NOW - 60 * TIME_MS.MINUTE).toISOString();
      const expectedEnd = new Date(MOCK_NOW).toISOString();

      expect(filter).toContain(`timestamp>="${expectedStart}"`);
      expect(filter).toContain(`timestamp<="${expectedEnd}"`);
    });
  });

  describe('Bounded provider log queries (Integration)', () => {
    it('looks for either correlated job or request ID in the padded event time window', () => {
      const at = '2026-11-03T11:00:00.000Z'; // 1 hour before MOCK_NOW
      const params = new URLSearchParams({ 
        correlation: CORRELATION_ID, 
        job: JOB_ID, 
        at, 
        minutes: '30' 
      });
      
      const request = parseLogRequest(params, MOCK_NOW);
      
      // Verify bounded time calculations (event time +/- context padding)
      const expectedCenter = Date.parse(at);
      const padding = LOG_CONFIG.CONTEXT_MINUTES * TIME_MS.MINUTE; // 15 mins padding
      
      expect(request.start).toBe(expectedCenter - padding);
      expect(request.end).toBe(expectedCenter + padding);

      // Verify the generated GCP filter incorporates all parsed parameters securely
      const filter = gcpLogFilter(request);
      
      expect(filter).toContain(`SEARCH("${CORRELATION_ID}") OR SEARCH("${JOB_ID}")`);
      expect(filter).toContain('resource.type="cloud_run_job"');
      
      // Ensure the correct start time is injected into the raw GCP query string
      const expectedIsoStart = new Date(expectedCenter - padding).toISOString();
      expect(filter).toContain(expectedIsoStart); // Ex: '2026-11-03T10:45:00.000Z'
    });
  });
});
