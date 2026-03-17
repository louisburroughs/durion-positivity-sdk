/**
 * SDK-003 Shared Transport Layer acceptance tests.
 *
 * Verifies that the shared transport package satisfies the acceptance criteria
 * defined in Story SDK-003.
 *
 * Structural tests cover transport package layout and exports (AC-1 through
 * AC-5, AC-10, AC-11).
 *
 * Behavioral tests verify SdkHttpClient header behavior for authorization,
 * correlation, idempotency, and API version handling (AC-6 through AC-9).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// __dirname resolves to src/__tests__; repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');
const TRANSPORT_PKG = path.join(REPO_ROOT, 'packages', 'sdk-transport');

// ---------------------------------------------------------------------------
// AC-1 — Transport package directory exists
// ---------------------------------------------------------------------------

describe('SDK-003 AC-1: packages/sdk-transport/ directory exists', () => {
  it('packages/sdk-transport/ path exists', () => {
    expect(fs.existsSync(TRANSPORT_PKG)).toBe(true);
  });

  it('packages/sdk-transport/ is a directory', () => {
    expect(fs.existsSync(TRANSPORT_PKG)).toBe(true);
    expect(fs.statSync(TRANSPORT_PKG).isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — Transport package has correct package.json
// ---------------------------------------------------------------------------

describe('SDK-003 AC-2: packages/sdk-transport/package.json', () => {
  const pkgJsonPath = path.join(TRANSPORT_PKG, 'package.json');

  it('package.json file exists', () => {
    expect(fs.existsSync(pkgJsonPath)).toBe(true);
  });

  it('name field is "@durion-sdk/transport"', () => {
    expect(fs.existsSync(pkgJsonPath)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
    expect(pkg['name']).toBe('@durion-sdk/transport');
  });
});

// ---------------------------------------------------------------------------
// AC-3 — Transport package has src directory
// ---------------------------------------------------------------------------

describe('SDK-003 AC-3: packages/sdk-transport/src/ directory exists', () => {
  it('packages/sdk-transport/src/ path exists', () => {
    const srcDir = path.join(TRANSPORT_PKG, 'src');
    expect(fs.existsSync(srcDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-4 — DurionSdkConfig interface is exported from src/index.ts
// ---------------------------------------------------------------------------

describe('SDK-003 AC-4: DurionSdkConfig exported from src/index.ts', () => {
  const indexPath = path.join(TRANSPORT_PKG, 'src', 'index.ts');

  it('packages/sdk-transport/src/index.ts exists', () => {
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  it('src/index.ts contains an export for DurionSdkConfig', () => {
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toMatch(/export\b.*\bDurionSdkConfig\b/);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — SdkHttpClient is exported from src/index.ts
// ---------------------------------------------------------------------------

describe('SDK-003 AC-5: SdkHttpClient exported from src/index.ts', () => {
  const indexPath = path.join(TRANSPORT_PKG, 'src', 'index.ts');

  it('src/index.ts contains an export for SdkHttpClient', () => {
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toMatch(/export\b.*\bSdkHttpClient\b/);
  });
});

// ---------------------------------------------------------------------------
// AC-10 — src/config.ts exists and exports DurionSdkConfig
// ---------------------------------------------------------------------------

describe('SDK-003 AC-10: packages/sdk-transport/src/config.ts', () => {
  const configPath = path.join(TRANSPORT_PKG, 'src', 'config.ts');

  it('src/config.ts exists', () => {
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('src/config.ts contains an export for DurionSdkConfig', () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/export\b.*\bDurionSdkConfig\b/);
  });
});

// ---------------------------------------------------------------------------
// AC-11 — src/http-client.ts exists and exports SdkHttpClient
// ---------------------------------------------------------------------------

describe('SDK-003 AC-11: packages/sdk-transport/src/http-client.ts', () => {
  const httpClientPath = path.join(TRANSPORT_PKG, 'src', 'http-client.ts');

  it('src/http-client.ts exists', () => {
    expect(fs.existsSync(httpClientPath)).toBe(true);
  });

  it('src/http-client.ts contains an export for SdkHttpClient', () => {
    expect(fs.existsSync(httpClientPath)).toBe(true);
    const content = fs.readFileSync(httpClientPath, 'utf-8');
    expect(content).toMatch(/export\b.*\bSdkHttpClient\b/);
  });
});

// ---------------------------------------------------------------------------
// AC-6 through AC-9 — Behavioral tests: SdkHttpClient header injection
//
// The @durion-sdk/transport package does not exist yet. The dynamic import
// in beforeAll will throw MODULE_NOT_FOUND; SdkHttpClient is set to null.
// Every behavioral test checks expect(SdkHttpClient).not.toBeNull() first,
// causing all tests in this describe block to fail RED intentionally.
//
// In GREEN phase these tests exercise the real implementation through the
// tsconfig path alias: @durion-sdk/transport => packages/sdk-transport/src.
// ---------------------------------------------------------------------------

/**
 * Resolves a named header value from any HeadersInit shape (Headers instance,
 * plain record, or entries array).  Header name lookup is case-insensitive.
 */
function getHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const entry = (headers as string[][]).find(
      ([k]) => k.toLowerCase() === name.toLowerCase(),
    );
    return entry ? (entry[1] ?? null) : null;
  }
  const obj = headers;
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : (obj[key] ?? null);
}

/** Minimum config shape expected of DurionSdkConfig in GREEN. */
interface TransportConfig {
  baseUrl: string;
  token?: () => string | Promise<string>;
  apiVersion?: string;
}

/**
 * Minimum constructor and method shape expected of SdkHttpClient in GREEN.
 * The request method accepts a method string, a URL path, and optional
 * per-call options (idempotency key, body, etc.).
 */
type SdkHttpClientCtor = new (config: TransportConfig) => {
  request(
    method: string,
    urlPath: string,
    options?: { idempotencyKey?: string; body?: unknown },
  ): Promise<Response>;
};

/**
 * TypeScript assertion function used as a RED guard in behavioral tests.
 * Throws when the transport module was not loaded (RED phase), which causes
 * the test to fail with a clear diagnostic message.  After this call TypeScript
 * narrows the type to non-null, so no casts or ! operators are required below.
 *
 * @param val   The value to assert as non-null.
 * @param label Human-readable label for the error message.
 */
function requireLoaded<T>(val: T | null, label: string): asserts val is T {
  if (val === null) {
    throw new Error(
      `${label} is null — @durion-sdk/transport module not found (expected RED failure)`,
    );
  }
}

describe('SDK-003 AC-6–9: SdkHttpClient header injection', () => {
  let SdkHttpClient: SdkHttpClientCtor | null;
  let mockFetch: jest.Mock;
  let savedFetch: unknown;

  beforeAll(async () => {
    // Snapshot real fetch so afterAll can restore it cleanly.
    savedFetch = (globalThis as Record<string, unknown>)['fetch'];

    try {
      // Attempt to load via tsconfig path alias; fails RED until GREEN scaffold.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — module does not exist yet; resolves to null in RED phase
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mod = await import('@durion-sdk/transport');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      SdkHttpClient = mod.SdkHttpClient as SdkHttpClientCtor;
    } catch {
      SdkHttpClient = null;
    }
  });

  afterAll(() => {
    (globalThis as Record<string, unknown>)['fetch'] = savedFetch;
  });

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    (globalThis as Record<string, unknown>)['fetch'] = mockFetch;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // -------------------------------------------------------------------------
  // AC-6: Authorization header injection
  // -------------------------------------------------------------------------

  it('AC-6: injects Authorization: Bearer <token> when a token function is configured', async () => {
    requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found

    const client = new SdkHttpClient({
      baseUrl: 'https://gateway.example.com',
      token: () => 'test-token',
    });
    await client.request('GET', '/v1/test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(getHeader(init.headers, 'Authorization')).toBe('Bearer test-token');
  });

  it('AC-6: omits Authorization header when no token is configured', async () => {
    requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found

    const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
    await client.request('GET', '/v1/test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(getHeader(init.headers, 'Authorization')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // AC-7: X-API-Version header injection
  // -------------------------------------------------------------------------

  it('AC-7: injects X-API-Version defaulting to "1" when apiVersion is not in config', async () => {
    requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found

    const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
    await client.request('GET', '/v1/test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(getHeader(init.headers, 'X-API-Version')).toBe('1');
  });

  it('AC-7: injects X-API-Version with the configured apiVersion value', async () => {
    requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found

    const client = new SdkHttpClient({
      baseUrl: 'https://gateway.example.com',
      apiVersion: '2',
    });
    await client.request('GET', '/v1/test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(getHeader(init.headers, 'X-API-Version')).toBe('2');
  });

  // -------------------------------------------------------------------------
  // AC-8: X-Correlation-Id header injection
  // -------------------------------------------------------------------------

  it('AC-8: injects X-Correlation-Id as a UUID-format value on every request', async () => {
    requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found

    const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
    await client.request('GET', '/v1/test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(getHeader(init.headers, 'X-Correlation-Id')).toMatch(UUID_PATTERN);
  });

  it('AC-8: generates a unique X-Correlation-Id per request', async () => {
    requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found

    const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
    await client.request('GET', '/v1/first');
    await client.request('GET', '/v1/second');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, init1] = mockFetch.mock.calls[0] as [string, RequestInit];
    const [, init2] = mockFetch.mock.calls[1] as [string, RequestInit];
    const id1 = getHeader(init1.headers, 'X-Correlation-Id');
    const id2 = getHeader(init2.headers, 'X-Correlation-Id');
    expect(id1).toMatch(UUID_PATTERN);
    expect(id2).toMatch(UUID_PATTERN);
    expect(id1).not.toBe(id2);
  });

  // -------------------------------------------------------------------------
  // AC-9: Idempotency-Key header injection (mutating requests only)
  // -------------------------------------------------------------------------

  it('AC-9: injects Idempotency-Key on POST requests when caller provides one', async () => {
    requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found

    const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
    await client.request('POST', '/v1/test', { idempotencyKey: 'key-abc-123' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(getHeader(init.headers, 'Idempotency-Key')).toBe('key-abc-123');
  });

  it('AC-9: does NOT inject Idempotency-Key on GET requests even when caller provides one', async () => {
    requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found

    const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
    await client.request('GET', '/v1/test', { idempotencyKey: 'key-abc-123' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(getHeader(init.headers, 'Idempotency-Key')).toBeNull();
  });
});
