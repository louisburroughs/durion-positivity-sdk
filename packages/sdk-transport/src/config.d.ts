export interface DurionSdkConfig {
    baseUrl: string;
    token?: () => string | Promise<string>;
    apiVersion?: string;
    /** Optional provider for the X-Correlation-Id header. Falls back to crypto.randomUUID() when absent. */
    correlationIdProvider?: () => string;
    /** Optional generator for idempotency keys. Receives HTTP method and URL. */
    idempotencyKeyGenerator?: (method: string, url: string) => string;
}
