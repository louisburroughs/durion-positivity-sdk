"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SdkHttpClient = void 0;
class SdkHttpClient {
    config;
    constructor(config) {
        this.config = config;
    }
    async request(method, url, options) {
        const headers = { ...options?.headers };
        if (this.config.token) {
            const token = await this.config.token();
            headers['Authorization'] = `Bearer ${token}`;
        }
        headers['X-API-Version'] = this.config.apiVersion ?? '1';
        headers['X-Correlation-Id'] = this.config.correlationIdProvider?.() ?? crypto.randomUUID();
        const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
        if (options?.idempotencyKey && mutatingMethods.includes(method.toUpperCase())) {
            headers['Idempotency-Key'] = options.idempotencyKey;
        }
        // Set Content-Type for JSON body if caller didn't already provide one
        if (options?.body !== undefined && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        const absoluteUrl = url.startsWith('http') ? url : `${this.config.baseUrl}${url}`;
        const body = options?.body === undefined ? undefined : JSON.stringify(options.body);
        return fetch(absoluteUrl, {
            method: method.toUpperCase(),
            headers,
            body,
        });
    }
    async buildRequestHeaders(method, options) {
        const headers = {};
        if (this.config.token) {
            const token = await this.config.token();
            headers['Authorization'] = `Bearer ${token}`;
        }
        headers['X-API-Version'] = this.config.apiVersion ?? '1';
        headers['X-Correlation-Id'] = this.config.correlationIdProvider?.() ?? crypto.randomUUID();
        const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
        if (options?.idempotencyKey && mutatingMethods.includes(method.toUpperCase())) {
            headers['Idempotency-Key'] = options.idempotencyKey;
        }
        return headers;
    }
}
exports.SdkHttpClient = SdkHttpClient;
