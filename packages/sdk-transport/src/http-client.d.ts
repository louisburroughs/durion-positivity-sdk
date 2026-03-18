import { DurionSdkConfig } from './config';
export declare class SdkHttpClient {
    private readonly config;
    constructor(config: DurionSdkConfig);
    private resolveIdempotencyKey;
    request(method: string, url: string, options?: {
        headers?: Record<string, string>;
        idempotencyKey?: string;
        body?: unknown;
    }): Promise<Response>;
    buildRequestHeaders(method: string, options?: {
        idempotencyKey?: string;
        url?: string;
    }): Promise<Record<string, string>>;
}
