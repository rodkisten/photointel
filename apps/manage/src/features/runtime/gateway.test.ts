import { describe, it, expect, vi } from 'vitest';
import { runtimeGateway } from './gateway';
import type { Env } from '../../auth';
describe('Manage runtime server adapter', () => {
  const identity = { email: 'owner@example.test', jwt: 'fixture' };
  it.each(['1', 'true'])('does not attach production credentials in preview %s', async (preview) => {
    const binding = { fetch: vi.fn() };
    await expect(
      runtimeGateway(
        new Request('https://manage.migos.club/api/runtime/targets'),
        {
          PHOTOINTEL_PREVIEW: preview,
          RODSANDBOX_RUNTIME: binding,
          ROD_RUNTIME_CONTROL_TOKEN: 'fixture'.repeat(8),
        } as unknown as Env,
        identity,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(binding.fetch).not.toHaveBeenCalled();
  });
  it('uses verified host identity and omits caller cookies, authorization and arbitrary headers', async () => {
    const binding = {
      fetch: vi.fn(async (request: Request) => {
        expect(request.headers.get('x-rod-subject')).toBe(identity.email);
        expect(request.headers.get('cookie')).toBeNull();
        expect(request.headers.get('authorization')).toBe('Bearer ' + 'fixture'.repeat(8));
        expect(request.headers.get('x-infrastructure-secret')).toBeNull();
        return Response.json({ targets: [] });
      }),
    };
    const response = await runtimeGateway(
      new Request('https://manage.migos.club/api/runtime/targets?workspaceId=test', {
        headers: {
          authorization: 'attacker',
          'x-rod-subject': 'attacker',
          cookie: 'host-cookie',
          'x-infrastructure-secret': 'caller-value',
        },
      }),
      { RODSANDBOX_RUNTIME: binding, ROD_RUNTIME_CONTROL_TOKEN: 'fixture'.repeat(8) } as unknown as Env,
      identity,
    );
    expect(response?.status).toBe(200);
    expect(binding.fetch).toHaveBeenCalledOnce();
  });
});
