import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { searchAssets } from '../api/generated-client';

afterEach(() => vi.unstubAllGlobals());

describe('OpenAPI search client', () => {
  it('serializes nested filter defaults and keeps authenticated requests on the API origin', async () => {
    let sent: Request | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      sent = input as Request;
      return Response.json({ items: [], next_cursor: null, explanation: {} });
    }));
    await searchAssets({ limit: 90, sort: 'captured_desc', filter: {
      op: 'and', children: [{ op: 'not', children: [{ op: 'tag', value: 'screenshot' }] }],
    } });
    expect(sent).toBeInstanceOf(Request);
    expect(new URL(sent!.url).origin).toBe(window.location.origin);
    expect(new URL(sent!.url).pathname).toBe('/v1/search');
    expect(sent!.credentials).toBe('include');
    expect(sent!.cache).toBe('no-store');
    expect(await sent!.json()).toEqual({ limit: 90, sort: 'captured_desc',
      minimum_similarity: 0, filter: { op: 'and', confidence: 0, comparison: 'gte',
        children: [{ op: 'not', confidence: 0, comparison: 'gte', children: [
          { op: 'tag', value: 'screenshot', confidence: 0, comparison: 'gte' },
        ] }],
      },
    });
  });

  it('reports an expired Access session without displaying the private gateway body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>private gateway</html>', {
      status: 401, headers: { 'X-Correlation-ID': 'access-expired' },
    })));
    await expect(searchAssets({ limit: 90, sort: 'captured_desc' })).rejects.toMatchObject({
      name: 'ApiError', status: 401, code: 'HTTP_401', correlationId: 'access-expired',
      message: 'Acesso não autorizado. Entre novamente pelo Cloudflare Access.',
    } satisfies Partial<ApiError>);
  });
});
