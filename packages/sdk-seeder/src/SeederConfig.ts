export interface SeederConfigShape {
  baseUrl: string;
  securityServiceUrl: string;
  username: string;
  password: string;
  days: number;
  seed: number | undefined;
  minCustomersPerDay: number;
  maxCustomersPerDay: number;
  pollIntervalMs: number;
}

/**
 * Explicit-value input for {@link SeederConfig.fromValues}. Only credentials
 * are required; every other field falls back to the same default that
 * {@link SeederConfig.fromEnv} applies, so the two construction paths share
 * one set of validation rules.
 */
export interface SeederConfigValues {
  baseUrl?: string;
  securityServiceUrl?: string;
  username: string;
  password: string;
  days?: number;
  seed?: number;
  minCustomersPerDay?: number;
  maxCustomersPerDay?: number;
  pollIntervalMs?: number;
}

function parseInteger(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer`);
  }
  return parsed;
}

export class SeederConfig implements SeederConfigShape {
  readonly baseUrl: string;
  readonly securityServiceUrl: string;
  readonly username: string;
  readonly password: string;
  readonly days: number;
  readonly seed: number | undefined;
  readonly minCustomersPerDay: number;
  readonly maxCustomersPerDay: number;
  readonly pollIntervalMs: number;

  private constructor(values: SeederConfigValues) {
    this.baseUrl = values.baseUrl ?? 'http://localhost:8080';
    this.securityServiceUrl = values.securityServiceUrl ?? 'http://localhost:8086';
    this.username = values.username;
    this.password = values.password;
    this.days = values.days ?? 365;
    this.seed = values.seed;
    this.minCustomersPerDay = values.minCustomersPerDay ?? 4;
    this.maxCustomersPerDay = values.maxCustomersPerDay ?? 12;
    this.pollIntervalMs = values.pollIntervalMs ?? 1000;

    if (!this.username) {
      throw new Error('username must be a non-empty string (SEEDER_USERNAME)');
    }
    if (!this.password) {
      throw new Error('password must be a non-empty string (SEEDER_PASSWORD)');
    }
    if (this.days <= 0) {
      throw new Error('SEEDER_DAYS must be greater than 0');
    }
    if (this.minCustomersPerDay < 0) {
      throw new Error('SEEDER_MIN_CUSTOMERS_PER_DAY must be greater than or equal to 0');
    }
    if (this.maxCustomersPerDay < this.minCustomersPerDay) {
      throw new Error('SEEDER_MAX_CUSTOMERS_PER_DAY must be greater than or equal to SEEDER_MIN_CUSTOMERS_PER_DAY');
    }
    if (this.pollIntervalMs <= 0) {
      throw new Error('SEEDER_POLL_INTERVAL_MS must be greater than 0');
    }
  }

  static fromEnv(): SeederConfig {
    return SeederConfig.fromEnvObject(process.env);
  }

  /**
   * Build a config from explicit values instead of SEEDER_* environment
   * variables — for callers with their own configuration surface (e.g. the
   * integration test harness mapping ITEST_* variables). Validation is
   * identical to {@link SeederConfig.fromEnv}.
   */
  static fromValues(values: SeederConfigValues): SeederConfig {
    return new SeederConfig(values);
  }

  private static fromEnvObject(env: NodeJS.ProcessEnv): SeederConfig {
    const required = (key: string): string => {
      const value = env[key];
      if (!value) {
        throw new Error(`Required environment variable ${key} is not set`);
      }
      return value;
    };

    const optInt = (key: string): number | undefined => {
      const value = env[key];
      return value !== undefined ? parseInteger(value, key) : undefined;
    };

    return new SeederConfig({
      baseUrl: env['SEEDER_BASE_URL'],
      securityServiceUrl: env['SEEDER_SECURITY_SERVICE_URL'],
      username: required('SEEDER_USERNAME'),
      password: required('SEEDER_PASSWORD'),
      days: optInt('SEEDER_DAYS'),
      seed: optInt('SEEDER_SEED'),
      minCustomersPerDay: optInt('SEEDER_MIN_CUSTOMERS_PER_DAY'),
      maxCustomersPerDay: optInt('SEEDER_MAX_CUSTOMERS_PER_DAY'),
      pollIntervalMs: optInt('SEEDER_POLL_INTERVAL_MS'),
    });
  }
}
