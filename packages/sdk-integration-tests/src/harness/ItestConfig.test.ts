import { ItestConfig } from './ItestConfig';

const baseEnv = {
  ITEST_USERNAME: 'admin-user',
  ITEST_PASSWORD: 'admin-pass',
};

describe('ItestConfig', () => {
  it('applies defaults with only the required credentials set', () => {
    const config = ItestConfig.fromEnv({ ...baseEnv });

    expect(config.baseUrl).toBe('http://localhost:8080');
    expect(config.securityServiceUrl).toBe('http://localhost:8086');
    expect(config.admin).toEqual({ username: 'admin-user', password: 'admin-pass' });
    expect(config.seed).toBeUndefined();
    expect(config.waitTimeoutMs).toBe(30000);
    expect(config.waitIntervalMs).toBe(500);
    expect(config.mode).toBe('single-credential');
  });

  it('honors explicit overrides', () => {
    const config = ItestConfig.fromEnv({
      ...baseEnv,
      ITEST_BASE_URL: 'http://localhost:18080',
      ITEST_SECURITY_SERVICE_URL: 'http://localhost:18086',
      ITEST_SEED: '1422',
      ITEST_WAIT_TIMEOUT_MS: '60000',
      ITEST_WAIT_INTERVAL_MS: '250',
    });

    expect(config.baseUrl).toBe('http://localhost:18080');
    expect(config.securityServiceUrl).toBe('http://localhost:18086');
    expect(config.seed).toBe(1422);
    expect(config.waitTimeoutMs).toBe(60000);
    expect(config.waitIntervalMs).toBe(250);
  });

  it('names every missing required variable in one error', () => {
    expect(() => ItestConfig.fromEnv({})).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/ITEST_USERNAME[\s\S]*ITEST_PASSWORD|ITEST_PASSWORD[\s\S]*ITEST_USERNAME/),
      }),
    );
  });

  it('rejects a non-integer timeout, naming the variable', () => {
    expect(() => ItestConfig.fromEnv({ ...baseEnv, ITEST_WAIT_TIMEOUT_MS: 'soon' })).toThrow(
      /ITEST_WAIT_TIMEOUT_MS/,
    );
    expect(() => ItestConfig.fromEnv({ ...baseEnv, ITEST_WAIT_INTERVAL_MS: '0' })).toThrow(
      /ITEST_WAIT_INTERVAL_MS/,
    );
    expect(() => ItestConfig.fromEnv({ ...baseEnv, ITEST_SEED: 'abc' })).toThrow(/ITEST_SEED/);
  });

  it('rejects a persona username without its password, and vice versa', () => {
    expect(() => ItestConfig.fromEnv({ ...baseEnv, ITEST_TECH_USERNAME: 'tech' })).toThrow(
      /ITEST_TECH_PASSWORD/,
    );
    expect(() => ItestConfig.fromEnv({ ...baseEnv, ITEST_ADVISOR_PASSWORD: 'p' })).toThrow(
      /ITEST_ADVISOR_USERNAME/,
    );
  });

  it('resolves role mode when at least one persona pair is fully set', () => {
    const config = ItestConfig.fromEnv({
      ...baseEnv,
      ITEST_TECH_USERNAME: 'tech-user',
      ITEST_TECH_PASSWORD: 'tech-pass',
    });

    expect(config.mode).toBe('role');
    expect(config.credentialsFor('tech')).toEqual({ username: 'tech-user', password: 'tech-pass' });
  });

  it('falls back to admin credentials for unconfigured personas', () => {
    const config = ItestConfig.fromEnv({
      ...baseEnv,
      ITEST_ADVISOR_USERNAME: 'advisor-user',
      ITEST_ADVISOR_PASSWORD: 'advisor-pass',
    });

    expect(config.credentialsFor('advisor')).toEqual({
      username: 'advisor-user',
      password: 'advisor-pass',
    });
    expect(config.credentialsFor('parts')).toEqual({
      username: 'admin-user',
      password: 'admin-pass',
    });
    expect(config.credentialsFor('admin')).toEqual({
      username: 'admin-user',
      password: 'admin-pass',
    });
  });

  it('recognizes every persona pair', () => {
    const config = ItestConfig.fromEnv({
      ...baseEnv,
      ITEST_ADVISOR_USERNAME: 'a',
      ITEST_ADVISOR_PASSWORD: 'a',
      ITEST_TECH_USERNAME: 't',
      ITEST_TECH_PASSWORD: 't',
      ITEST_MANAGER_USERNAME: 'm',
      ITEST_MANAGER_PASSWORD: 'm',
      ITEST_PARTS_USERNAME: 'p',
      ITEST_PARTS_PASSWORD: 'p',
      ITEST_ACCT_USERNAME: 'ac',
      ITEST_ACCT_PASSWORD: 'ac',
    });

    expect(config.mode).toBe('role');
    for (const persona of ['advisor', 'tech', 'manager', 'parts', 'acct'] as const) {
      expect(config.credentialsFor(persona).username).not.toBe('admin-user');
    }
  });
});
