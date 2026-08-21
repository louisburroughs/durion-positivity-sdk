import {
  BootstrapOrchestrator,
  SecurityBootstrap,
  SeederAuth,
  SeederConfig,
  SeederRandom,
  SEED_VENDOR_ID,
  type ReferenceCache,
} from '@durion-sdk/seeder';

describe('sdk-seeder library barrel', () => {
  it('exports the bootstrap fixtures as constructible classes', () => {
    expect(typeof SeederAuth).toBe('function');
    expect(typeof SeederConfig).toBe('function');
    expect(typeof SecurityBootstrap).toBe('function');
    expect(typeof BootstrapOrchestrator).toBe('function');
    expect(typeof SeederRandom).toBe('function');
  });

  it('exports the seed vendor id used by inventory bootstrap and restock', () => {
    expect(SEED_VENDOR_ID).toBe('sdk-seeder-vendor-main');
  });

  it('exports ReferenceCache as a usable type', () => {
    const refs: ReferenceCache = {
      locationId: 'loc-1',
      bayIds: [],
      employees: { technicians: [], serviceWriters: [], manager: 'm-1', partsClerk: 'p-1' },
      serviceEntityIds: [],
      productEntityIds: [],
      serviceNameById: new Map(),
      productNameById: new Map(),
      employeeNameById: new Map(),
    };
    expect(refs.locationId).toBe('loc-1');
  });

  describe('SeederConfig.fromValues', () => {
    it('builds a config from explicit values with defaults applied', () => {
      const config = SeederConfig.fromValues({
        username: 'itest-user',
        password: 'itest-pass',
      });

      expect(config.baseUrl).toBe('http://localhost:8080');
      expect(config.securityServiceUrl).toBe('http://localhost:8086');
      expect(config.username).toBe('itest-user');
      expect(config.password).toBe('itest-pass');
      expect(config.days).toBe(365);
      expect(config.seed).toBeUndefined();
      expect(config.minCustomersPerDay).toBe(4);
      expect(config.maxCustomersPerDay).toBe(12);
      expect(config.pollIntervalMs).toBe(1000);
    });

    it('honors explicit overrides', () => {
      const config = SeederConfig.fromValues({
        baseUrl: 'http://localhost:18080',
        securityServiceUrl: 'http://localhost:18086',
        username: 'u',
        password: 'p',
        days: 1,
        seed: 1422,
        minCustomersPerDay: 0,
        maxCustomersPerDay: 2,
        pollIntervalMs: 250,
      });

      expect(config.baseUrl).toBe('http://localhost:18080');
      expect(config.securityServiceUrl).toBe('http://localhost:18086');
      expect(config.days).toBe(1);
      expect(config.seed).toBe(1422);
      expect(config.minCustomersPerDay).toBe(0);
      expect(config.maxCustomersPerDay).toBe(2);
      expect(config.pollIntervalMs).toBe(250);
    });

    it('rejects missing credentials', () => {
      expect(() => SeederConfig.fromValues({ username: '', password: 'p' })).toThrow(/username/);
      expect(() => SeederConfig.fromValues({ username: 'u', password: '' })).toThrow(/password/);
    });

    it('applies the same invariants as fromEnv', () => {
      expect(() => SeederConfig.fromValues({ username: 'u', password: 'p', days: 0 })).toThrow(
        /SEEDER_DAYS must be greater than 0/,
      );
      expect(() =>
        SeederConfig.fromValues({ username: 'u', password: 'p', minCustomersPerDay: -1 }),
      ).toThrow(/SEEDER_MIN_CUSTOMERS_PER_DAY/);
      expect(() =>
        SeederConfig.fromValues({
          username: 'u',
          password: 'p',
          minCustomersPerDay: 5,
          maxCustomersPerDay: 4,
        }),
      ).toThrow(/SEEDER_MAX_CUSTOMERS_PER_DAY/);
      expect(() =>
        SeederConfig.fromValues({ username: 'u', password: 'p', pollIntervalMs: 0 }),
      ).toThrow(/SEEDER_POLL_INTERVAL_MS/);
    });
  });

  describe('SeederConfig.fromEnv', () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it('still reads SEEDER_* variables', () => {
      process.env['SEEDER_USERNAME'] = 'env-user';
      process.env['SEEDER_PASSWORD'] = 'env-pass';
      process.env['SEEDER_DAYS'] = '7';

      const config = SeederConfig.fromEnv();
      expect(config.username).toBe('env-user');
      expect(config.days).toBe(7);
    });

    it('still fails fast on missing credentials', () => {
      delete process.env['SEEDER_USERNAME'];
      delete process.env['SEEDER_PASSWORD'];

      expect(() => SeederConfig.fromEnv()).toThrow(/SEEDER_USERNAME/);
    });
  });

  it('SeederRandom is deterministic for a fixed seed', () => {
    const a = new SeederRandom(1422);
    const b = new SeederRandom(1422);
    expect(a.firstName()).toBe(b.firstName());
    expect(a.lastName()).toBe(b.lastName());
  });
});
