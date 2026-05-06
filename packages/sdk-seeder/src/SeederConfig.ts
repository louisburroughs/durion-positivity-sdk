export interface SeederConfigShape {
  baseUrl: string;
  securityServiceUrl: string;
  username: string;
  password: string;
  days: number;
  scale: number;
  seed: number | undefined;
  minCustomersPerDay: number;
  maxCustomersPerDay: number;
  sleepBetweenDaysMs: number;
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
  readonly scale: number;
  readonly seed: number | undefined;
  readonly minCustomersPerDay: number;
  readonly maxCustomersPerDay: number;
  readonly sleepBetweenDaysMs: number;

  private constructor(env: NodeJS.ProcessEnv) {
    const required = (key: string): string => {
      const value = env[key];
      if (!value) {
        throw new Error(`Required environment variable ${key} is not set`);
      }
      return value;
    };

    const optInt = (key: string, defaultValue: number): number => {
      const value = env[key];
      return value !== undefined ? parseInteger(value, key) : defaultValue;
    };

    this.baseUrl = env['SEEDER_BASE_URL'] ?? 'http://localhost:8080';
    this.securityServiceUrl = env['SEEDER_SECURITY_SERVICE_URL'] ?? 'http://localhost:8086';
    this.username = required('SEEDER_USERNAME');
    this.password = required('SEEDER_PASSWORD');
    this.days = optInt('SEEDER_DAYS', 365);
    this.scale = optInt('SEEDER_SCALE', 1000);
    this.seed = env['SEEDER_SEED'] !== undefined ? parseInteger(env['SEEDER_SEED'], 'SEEDER_SEED') : undefined;
    this.minCustomersPerDay = optInt('SEEDER_MIN_CUSTOMERS_PER_DAY', 4);
    this.maxCustomersPerDay = optInt('SEEDER_MAX_CUSTOMERS_PER_DAY', 12);

    if (this.scale <= 0) {
      throw new Error('SEEDER_SCALE must be greater than 0');
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

    this.sleepBetweenDaysMs = Math.floor(86_400_000 / this.scale);
  }

  static fromEnv(): SeederConfig {
    return new SeederConfig(process.env);
  }
}
