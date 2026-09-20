import { assertAcceleratedBackend, ClockConvergedError, VirtualClock } from './virtualClock';

const REAL_START = '2026-09-17T12:00:00.000Z';
const VIRTUAL_START = '2025-09-17T12:00:00.000Z';

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  virtualTime: '2025-11-03T08:30:00.000Z',
  scale: 1460,
  zone: 'UTC',
  accelerated: true,
  converged: false,
  realStart: REAL_START,
  virtualStart: VIRTUAL_START,
  ...overrides,
});

const respond = (status: number, payload: unknown): typeof fetch =>
  (async () =>
    ({
      status,
      ok: status >= 200 && status < 300,
      statusText: `status ${status}`,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }) as unknown as Response) as unknown as typeof fetch;

const unparseable: typeof fetch = (async () =>
  ({
    status: 200,
    ok: true,
    statusText: 'OK',
    json: async () => {
      throw new Error('Unexpected token < in JSON');
    },
  }) as unknown as Response) as unknown as typeof fetch;

const clockWith = (fetchImpl: typeof fetch, options = {}) =>
  new VirtualClock('http://gateway:8080', { fetchImpl, ...options });

describe('VirtualClock', () => {
  it('reads and validates an accelerated response', async () => {
    const reading = await clockWith(respond(200, body())).read();

    expect(reading.virtualTime.toISOString()).toBe('2025-11-03T08:30:00.000Z');
    expect(reading.scale).toBe(1460);
    expect(reading.accelerated).toBe(true);
    expect(reading.converged).toBe(false);
    expect(reading.realStart.toISOString()).toBe(REAL_START);
  });

  it('remembers the last reading for logging', async () => {
    const clock = clockWith(respond(200, body()));
    expect(clock.lastRead).toBeUndefined();
    await clock.read();
    expect(clock.lastRead?.scale).toBe(1460);
  });

  it('points a 404 at the non-accelerated entry point instead of guessing', async () => {
    await expect(clockWith(respond(404, {})).read()).rejects.toThrow(
      /answered 404 .* normal clock[\s\S]*npm run test:integration/,
    );
  });

  it('fails on a 5xx', async () => {
    await expect(clockWith(respond(503, {})).read()).rejects.toThrow(/HTTP 503/);
  });

  it('fails on a body that is not JSON', async () => {
    await expect(clockWith(unparseable).read()).rejects.toThrow(/not JSON/);
  });

  it('names the endpoint and the tunnel when the backend is unreachable', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(clockWith(boom).read()).rejects.toThrow(/cannot reach http:\/\/gateway:8080\/system\/time .*ECONNREFUSED.*tunnel/);
  });

  it('refuses a clock that is present but not accelerating', async () => {
    await expect(clockWith(respond(200, body({ accelerated: false }))).read()).rejects.toThrow(
      /accelerated must be true/,
    );
  });

  it.each([0, 1, -5, Number.NaN, 'fast', null])('refuses scale %p', async (scale) => {
    await expect(clockWith(respond(200, body({ scale }))).read()).rejects.toThrow(/scale must be a finite number/);
  });

  it('refuses an unknown zone', async () => {
    await expect(clockWith(respond(200, body({ zone: 'Mars/Olympus' }))).read()).rejects.toThrow(
      /zone must be an IANA zone id/,
    );
  });

  it('refuses unparseable anchors', async () => {
    await expect(clockWith(respond(200, body({ virtualTime: 'yesterday' }))).read()).rejects.toThrow(
      /virtualTime is not a parseable instant/,
    );
    await expect(clockWith(respond(200, body({ realStart: undefined }))).read()).rejects.toThrow(
      /realStart must be an ISO instant/,
    );
  });

  it('refuses anchors with no timeline between them', async () => {
    // Not a length check. A pair that does not go backwards has no run in it at all,
    // whatever the deployment was asked for.
    await expect(
      clockWith(respond(200, body({ virtualStart: REAL_START, virtualTime: REAL_START }))).read(),
    ).rejects.toThrow(/does not precede realStart/);
  });

  it('accepts a timeline far shorter than a year', async () => {
    // The deploy workflow anchors from its own `days` input
    // (durion-positivity-backend#2136), so a short timeline is a legitimate
    // deployment. The old guard refused every one of them after a successful deploy.
    const reading = await clockWith(
      respond(200, body({ virtualStart: '2026-06-17T12:00:00.000Z', virtualTime: '2026-06-18T00:00:00.000Z' })),
    ).read();
    expect(reading.remainingDays).toBeGreaterThan(1);
  });

  it('refuses a timeline with almost nothing left to drive', async () => {
    // The containers close the gap from the moment they boot, so a suite dispatched
    // late can find the year already spent. Better to say so at setup than to drive
    // one virtual day and stop.
    const nearlyNow = new Date(Date.now() - 30_000).toISOString();
    await expect(clockWith(respond(200, body({ virtualTime: nearlyNow }))).read()).rejects.toThrow(
      /virtual day\(s\) remain before the clock converges/,
    );
  });

  it('reports what is left rather than what was deployed', async () => {
    // The figure a run can plan against: the anchors say how long the timeline was,
    // this says how much of it survives. Derived from the reading alone, so it stays
    // right across a re-dispatch that moves the anchors.
    const reading = await clockWith(respond(200, body())).read();
    const gapDays = (reading.readAt.getTime() - reading.virtualTime.getTime()) / (24 * 60 * 60 * 1000);
    expect(reading.remainingDays).toBeCloseTo((1460 * gapDays) / 1459, 3);
    // Strictly less than the deployed gap, because time has already been spent.
    const deployedGap = (Date.parse(REAL_START) - Date.parse(VIRTUAL_START)) / (24 * 60 * 60 * 1000);
    expect(reading.remainingDays).toBeLessThan(deployedGap + 1);
  });

  it('refuses a virtualTime before virtualStart', async () => {
    await expect(clockWith(respond(200, body({ virtualTime: '2025-01-01T00:00:00.000Z' }))).read()).rejects.toThrow(
      /is before virtualStart/,
    );
  });

  it('refuses a virtualTime far ahead of the local wall clock', async () => {
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
    await expect(
      clockWith(respond(200, body({ virtualTime: ahead })), { maxSkewMs: 60_000 }).read(),
    ).rejects.toThrow(/ahead of the local wall clock/);
  });

  it('collects every problem into one error', async () => {
    const message = await clockWith(respond(200, body({ accelerated: false, scale: 0, zone: 'nope' })))
      .read()
      .catch((error: Error) => error.message);
    expect(message).toMatch(/accelerated must be true/);
    expect(message).toMatch(/scale must be a finite number/);
    expect(message).toMatch(/zone must be an IANA zone id/);
  });

  it('exposes now() as the virtual instant', async () => {
    await expect(clockWith(respond(200, body())).now()).resolves.toEqual(new Date('2025-11-03T08:30:00.000Z'));
  });
});

describe('assertAcceleratedBackend', () => {
  it('returns the reading so setup can record the anchors', async () => {
    const reading = await assertAcceleratedBackend('http://gateway:8080', { fetchImpl: respond(200, body()) });
    expect(reading.virtualStart.toISOString()).toBe(VIRTUAL_START);
  });

  it('refuses a converged clock: the timeline is already spent', async () => {
    await expect(
      assertAcceleratedBackend('http://gateway:8080', { fetchImpl: respond(200, body({ converged: true })) }),
    ).rejects.toThrow(ClockConvergedError);
  });
});
