import { createShopManagerClient } from './shopManagerClient';

/**
 * The bypass this pins: the token provider is awaited on every request, so a
 * provider that renews inside itself gets the chance to. Typed as returning a
 * plain string, the client sent whatever token was current when the call started —
 * which on an accelerated clock is expired within a second or two, and the
 * appointment paths that do not go through `call` have no other recovery.
 */
describe('createShopManagerClient', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('awaits the token provider on every request', async () => {
    const seen: string[] = [];
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('Authorization') ?? '(none)');
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    let minted = 0;
    const client = createShopManagerClient({
      baseUrl: 'http://localhost:18080',
      // Asynchronous, and different every time — a renewal happening inside the
      // provider is exactly the case that matters.
      token: async () => {
        minted += 1;
        return `token-${minted}`;
      },
    });

    const id = '00000000-0000-0000-0000-000000000001';
    await client.appointmentsApi.getAppointmentById({ appointmentId: id }).catch(() => undefined);
    await client.appointmentsApi.getAppointmentById({ appointmentId: id }).catch(() => undefined);

    expect(seen).toEqual(['Bearer token-1', 'Bearer token-2']);
  });
});
