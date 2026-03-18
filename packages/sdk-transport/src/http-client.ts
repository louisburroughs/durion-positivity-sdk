import { DurionSdkConfig } from './config';

export class SdkHttpClient {
  constructor(private readonly config: DurionSdkConfig) { }

  private resolveIdempotencyKey(
    method: string,
    url: string,
    explicitIdempotencyKey?: string
  ): string | undefined {
    const normalizedMethod = method.toUpperCase();
    const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (!mutatingMethods.includes(normalizedMethod)) {
      return undefined;
    }

    if (explicitIdempotencyKey) {
      return explicitIdempotencyKey;
    }

    return this.config.idempotencyKeyGenerator?.(normalizedMethod, url);
  }

  async request(
    method: string,
    url: string,
    options?: {
      headers?: Record<string, string>;
      idempotencyKey?: string;
      body?: unknown;
    }
  ): Promise<Response> {
    const headers: Record<string, string> = { ...options?.headers };

    if (this.config.token) {
      const token = await this.config.token();
      headers['Authorization'] = `Bearer ${token}`;
    }

    headers['X-API-Version'] = this.config.apiVersion ?? '1';
    headers['X-Correlation-Id'] = this.config.correlationIdProvider?.() ?? crypto.randomUUID();

    const absoluteUrl = url.startsWith('http') ? url : `${this.config.baseUrl}${url}`;
    const idempotencyKey = this.resolveIdempotencyKey(method, absoluteUrl, options?.idempotencyKey);
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    // Set Content-Type for JSON body if caller didn't already provide one
    if (options?.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const body = options?.body === undefined ? undefined : JSON.stringify(options.body);

    return fetch(absoluteUrl, {
      method: method.toUpperCase(),
      headers,
      body,
    });
  }

  async buildRequestHeaders(
    method: string,
    options?: { idempotencyKey?: string; url?: string }
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    if (this.config.token) {
      const token = await this.config.token();
      headers['Authorization'] = `Bearer ${token}`;
    }

    headers['X-API-Version'] = this.config.apiVersion ?? '1';
    headers['X-Correlation-Id'] = this.config.correlationIdProvider?.() ?? crypto.randomUUID();

    const normalizedUrl = options?.url
      ? (options.url.startsWith('http') ? options.url : `${this.config.baseUrl}${options.url}`)
      : undefined;
    const idempotencyKey = normalizedUrl
      ? this.resolveIdempotencyKey(method, normalizedUrl, options?.idempotencyKey)
      : options?.idempotencyKey;
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return headers;
  }
}
