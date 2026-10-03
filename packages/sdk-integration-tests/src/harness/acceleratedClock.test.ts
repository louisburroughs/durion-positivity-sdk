import { assertNonAcceleratedBackend, isConvergedClock } from './acceleratedClock';

const BASE = 'http://backend.test';

const stubFetch = (status: number, body: string): void => {
  global.fetch = jest.fn().mockResolvedValue({ status, text: () => Promise.resolve(body) }) as unknown as typeof fetch;
};

describe('isConvergedClock', () => {
  it('accepts only an explicit converged: true', () => {
    expect(isConvergedClock('{"accelerated":true,"converged":true}')).toBe(true);
    expect(isConvergedClock('{"accelerated":true,"converged":false}')).toBe(false);
    expect(isConvergedClock('{"accelerated":true}')).toBe(false);
    expect(isConvergedClock('not json')).toBe(false);
  });
});

describe('assertNonAcceleratedBackend', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('proceeds on the normal clock (no /system/time)', async () => {
    stubFetch(404, '');
    await expect(assertNonAcceleratedBackend(BASE)).resolves.toBeUndefined();
  });

  it('refuses a converged accelerated clock by default', async () => {
    stubFetch(200, '{"converged":true}');
    await expect(assertNonAcceleratedBackend(BASE)).rejects.toThrow(/accelerated/);
  });

  it('accepts a converged clock when the caller allows it', async () => {
    stubFetch(200, '{"converged":true}');
    await expect(assertNonAcceleratedBackend(BASE, { allowConverged: true })).resolves.toBeUndefined();
  });

  it('still refuses a clock that is accelerating, even when converged clocks are allowed', async () => {
    stubFetch(200, '{"converged":false,"scale":1000}');
    await expect(assertNonAcceleratedBackend(BASE, { allowConverged: true })).rejects.toThrow(/mid-accelerated-run/);
  });
});
