import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyAccess, bodyJson, requireOrigin, redact, ApiError, Env } from './auth';

// --- Test Helpers ---

// Generates a mock Base64Url encoded JWT segment
const b64u = (obj: unknown) => 
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const VALID_AUDIENCE = '12345678901234567890123456789012'; // Must be >= 20 chars
const VALID_DOMAIN = 'test.cloudflareaccess.com';
const ISSUER = `https://${VALID_DOMAIN}`;

const getValidEnv = (): Env => ({
  ACCESS_TEAM_DOMAIN: VALID_DOMAIN,
  ACCESS_AUDIENCE: VALID_AUDIENCE,
  ACCESS_ALLOWED_EMAILS: JSON.stringify(['admin@example.com', 'user@example.com']),
} as Env);

describe('Auth & Utilities', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('redact', () => {
    it('redacts bearer tokens', () => {
      const log = 'Failed to fetch Bearer 12345-secret-token from API';
      expect(redact(log)).toBe('Failed to fetch Bearer [redacted] from API');
    });

    it('redacts sensitive keys (password, token, secret, cookie)', () => {
      const log = 'DB connection failed: password=supersecret, user=admin';
      expect(redact(log)).toBe('DB connection failed: password=[redacted] user=admin');
      
      const jsonLog = { authorization: 'Bearer xyz', other: 'public' };
      expect(redact(jsonLog)).toContain('authorization":"[redacted]');
      expect(redact(jsonLog)).toContain('public');
    });

    it('redacts private URLs with query strings', () => {
      const log = 'Webhook sent to https://api.service.com/v1/trigger?token=secret123&user=1';
      expect(redact(log)).toBe('Webhook sent to [URL privada]');
    });

    it('redacts raw JWTs', () => {
      const log = 'Token is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      expect(redact(log)).toBe('Token is [JWT omitted]');
    });
  });

  describe('requireOrigin', () => {
    it('passes if Origin matches the Request URL origin', () => {
      const req = new Request('https://api.photointel.com/v1/data', {
        headers: { Origin: 'https://api.photointel.com' }
      });
      expect(() => requireOrigin(req)).not.toThrow();
    });

    it('throws 403 CSRF if Origin mismatches', () => {
      const req = new Request('https://api.photointel.com/v1/data', {
        headers: { Origin: 'https://evil.com' }
      });
      expect(() => requireOrigin(req)).toThrowError(ApiError);
      expect(() => requireOrigin(req)).toThrowError(/Origem não permitida/);
    });
  });

  describe('bodyJson', () => {
    it('parses valid JSON', async () => {
      const req = new Request('https://test.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' })
      });
      const data = await bodyJson<{ key: string }>(req);
      expect(data.key).toBe('value');
    });

    it('throws 415 if Content-Type is missing or wrong', async () => {
      const req = new Request('https://test.com', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'hello'
      });
      await expect(bodyJson(req)).rejects.toThrowError(/Use application\/json/);
    });

    it('throws 413 if Content-Length exceeds max limit', async () => {
      const req = new Request('https://test.com', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Content-Length': '999999' 
        },
        body: '{}' // Body doesn't matter, header triggers early rejection
      });
      await expect(bodyJson(req, 1000)).rejects.toThrowError(/Corpo muito grande/);
    });

    it('throws 400 on invalid JSON format', async () => {
      const req = new Request('https://test.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ broken: true }'
      });
      await expect(bodyJson(req)).rejects.toThrowError(/JSON inválido/);
    });
  });

  describe('verifyAccess', () => {
    const validHeader = { alg: 'RS256', kid: 'key-1' };
    const validPayload = {
      iss: ISSUER,
      aud: VALID_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 3600, // Valid for 1 hour
      email: 'admin@example.com'
    };

    it('throws 503 if Cloudflare Access environment is unconfigured', async () => {
      const req = new Request('https://test.com');
      await expect(verifyAccess(req, {} as Env)).rejects.toThrowError(/Configure Cloudflare Access/);
    });

    it('throws 401 if JWT is completely missing', async () => {
      const req = new Request('https://test.com');
      await expect(verifyAccess(req, getValidEnv())).rejects.toThrowError(/Login Cloudflare Access necessário/);
    });

    it('throws 401 if JWT has invalid claims (e.g., wrong issuer)', async () => {
      const invalidPayload = { ...validPayload, iss: 'https://wrong-issuer.com' };
      const jwt = `${b64u(validHeader)}.${b64u(invalidPayload)}.signature`;
      
      const req = new Request('https://test.com', {
        headers: { 'Cf-Access-Jwt-Assertion': jwt }
      });

      await expect(verifyAccess(req, getValidEnv())).rejects.toThrowError(/Token Access inválido ou expirado/);
    });

    it('throws 401 if JWT is expired', async () => {
      const expiredPayload = { ...validPayload, exp: Math.floor(Date.now() / 1000) - 3600 };
      const jwt = `${b64u(validHeader)}.${b64u(expiredPayload)}.signature`;
      
      const req = new Request('https://test.com', {
        headers: { 'Cf-Access-Jwt-Assertion': jwt }
      });

      await expect(verifyAccess(req, getValidEnv())).rejects.toThrowError(/Token Access inválido ou expirado/);
    });

    it('throws 403 if email is not in the allowlist', async () => {
      const unauthorizedPayload = { ...validPayload, email: 'hacker@evil.com' };
      const jwt = `${b64u(validHeader)}.${b64u(unauthorizedPayload)}.signature`;
      
      const req = new Request('https://test.com', {
        headers: { 'Cf-Access-Jwt-Assertion': jwt }
      });

      await expect(verifyAccess(req, getValidEnv())).rejects.toThrowError(/Conta não autorizada/);
    });

    it('fetches JWKs and verifies signature for a valid allowed request', async () => {
      const jwt = `${b64u(validHeader)}.${b64u(validPayload)}.dHVtbXlfc2lnbmF0dXJl`;
      const req = new Request('https://test.com', {
        headers: { 'Cf-Access-Jwt-Assertion': jwt }
      });

      // Mock the network fetch for JWKs
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
        keys: [{ kid: 'key-1', kty: 'RSA', n: 'mock', e: 'AQAB' }]
      })));

      // Mock the Subtles Crypto API so we don't need real RSA keypairs in unit tests
      vi.stubGlobal('crypto', {
        subtle: {
          importKey: vi.fn().mockResolvedValue('mock-crypto-key'),
          verify: vi.fn().mockResolvedValue(true) // Force successful signature verification
        }
      });

      const identity = await verifyAccess(req, getValidEnv());
      
      expect(identity.email).toBe('admin@example.com');
      expect(identity.jwt).toBe(jwt);
      expect(global.fetch).toHaveBeenCalledWith(`${ISSUER}/cdn-cgi/access/certs`, expect.any(Object));
      expect(crypto.subtle.verify).toHaveBeenCalled();
    });
  });
});
