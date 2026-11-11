import * as path from 'path';
import { loadQaConfig, REPO_ROOT } from './config';

const GATEWAY = 'http://localhost:18080/';

describe('loadQaConfig', () => {
  it('has working defaults', () => {
    const config = loadQaConfig({}, GATEWAY);
    expect(config).toMatchObject({
      timezone: 'America/New_York',
      runDays: [1, 2, 3, 4, 5, 6],
      coverageLevel: 'package',
      policy: { mode: 'mutating', allowDestructive: false, deny: [] },
      sweepWrites: false,
      maxPerTick: 3,
      concurrency: 3,
      minGapMinutes: 2,
      day: { visitsMin: 4, visitsMax: 8, tenantMax: 60, newCustomerRatio: 0.3, commercialRatio: 0.3, newVehicleRatio: 0.2, openTime: '08:00', closeTime: '17:30', seed: 0 },
      stateDir: path.join(REPO_ROOT, '.agent-qa'),
    });
  });

  it('routes each package through its gateway prefix', () => {
    const config = loadQaConfig({}, GATEWAY);
    expect(config.baseUrlFor('order')).toBe('http://localhost:18080/order');
    expect(config.baseUrlFor('vehicle-inventory')).toBe('http://localhost:18080/vehicle-inventory');
    expect(config.baseUrlFor('security')).toBe('http://localhost:18080/security-service');
  });

  it('treats services the gateway does not route as unreachable until given a direct URL', () => {
    expect(loadQaConfig({}, GATEWAY).baseUrlFor('internal')).toBeUndefined();
    expect(loadQaConfig({}, GATEWAY).baseUrlFor('documents')).toBeUndefined();
    const direct = loadQaConfig({ QA_SERVICE_URL_INTERNAL: 'http://localhost:8095/', QA_SERVICE_URL_PEOPLE_CONTACT: 'http://localhost:9001' }, GATEWAY);
    expect(direct.baseUrlFor('internal')).toBe('http://localhost:8095');
    expect(direct.baseUrlFor('people-contact')).toBe('http://localhost:9001');
  });

  it('reads overrides', () => {
    const config = loadQaConfig(
      { QA_MODE: 'read-only', QA_ALLOW_DESTRUCTIVE: 'true', QA_DENY: '^marketing\\., Stripe', QA_RUN_DAYS: '1,3,5', QA_COVERAGE_LEVEL: 'method', QA_STATE_DIR: '/var/qa', QA_MAX_STEPS: '12' },
      GATEWAY,
    );
    expect(config.policy.mode).toBe('read-only');
    expect(config.policy.allowDestructive).toBe(true);
    expect(config.policy.deny.map(String)).toEqual(['/^marketing\\./', '/Stripe/']);
    expect(config.runDays).toEqual([1, 3, 5]);
    expect(config.stateDir).toBe('/var/qa');
    expect(config.limits.maxSteps).toBe(12);
  });

  it('reports every problem at once', () => {
    let message = '';
    try {
      loadQaConfig({ QA_MODE: 'yolo', QA_RUN_DAYS: '0,9', QA_DENY: '(', QA_MAX_STEPS: 'many' }, GATEWAY);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const key of ['QA_MODE', 'QA_RUN_DAYS', 'QA_MAX_STEPS', 'QA_DENY']) {
      expect(message).toContain(`- ${key}:`);
    }
    expect(() => loadQaConfig({ QA_TIMEZONE: 'Mars/Olympus' }, GATEWAY)).toThrow(/QA_TIMEZONE/);
  });
});
