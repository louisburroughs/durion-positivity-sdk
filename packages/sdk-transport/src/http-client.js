"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SdkHttpClient = void 0;
class SdkHttpClient {
    constructor(config) {
        this.config = config;
    }
    resolveIdempotencyKey(method, url, explicitIdempotencyKey) {
        var _a, _b;
        const normalizedMethod = method.toUpperCase();
        const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
        if (!mutatingMethods.includes(normalizedMethod)) {
            return undefined;
        }
        if (explicitIdempotencyKey) {
            return explicitIdempotencyKey;
        }
        return (_b = (_a = this.config).idempotencyKeyGenerator) === null || _b === void 0 ? void 0 : _b.call(_a, normalizedMethod, url);
    }
    request(method, url, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            const headers = Object.assign({}, options === null || options === void 0 ? void 0 : options.headers);
            if (this.config.token) {
                const token = yield this.config.token();
                headers['Authorization'] = `Bearer ${token}`;
            }
            headers['X-API-Version'] = (_a = this.config.apiVersion) !== null && _a !== void 0 ? _a : '1';
            headers['X-Correlation-Id'] = (_d = (_c = (_b = this.config).correlationIdProvider) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : crypto.randomUUID();
            const absoluteUrl = url.startsWith('http') ? url : `${this.config.baseUrl}${url}`;
            const idempotencyKey = this.resolveIdempotencyKey(method, absoluteUrl, options === null || options === void 0 ? void 0 : options.idempotencyKey);
            if (idempotencyKey) {
                headers['Idempotency-Key'] = idempotencyKey;
            }
            // Set Content-Type for JSON body if caller didn't already provide one
            if ((options === null || options === void 0 ? void 0 : options.body) !== undefined && !headers['Content-Type']) {
                headers['Content-Type'] = 'application/json';
            }
            const body = (options === null || options === void 0 ? void 0 : options.body) === undefined ? undefined : JSON.stringify(options.body);
            return fetch(absoluteUrl, {
                method: method.toUpperCase(),
                headers,
                body,
            });
        });
    }
    buildRequestHeaders(method, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            const headers = {};
            if (this.config.token) {
                const token = yield this.config.token();
                headers['Authorization'] = `Bearer ${token}`;
            }
            headers['X-API-Version'] = (_a = this.config.apiVersion) !== null && _a !== void 0 ? _a : '1';
            headers['X-Correlation-Id'] = (_d = (_c = (_b = this.config).correlationIdProvider) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : crypto.randomUUID();
            const normalizedUrl = (options === null || options === void 0 ? void 0 : options.url)
                ? (options.url.startsWith('http') ? options.url : `${this.config.baseUrl}${options.url}`)
                : undefined;
            const idempotencyKey = normalizedUrl
                ? this.resolveIdempotencyKey(method, normalizedUrl, options === null || options === void 0 ? void 0 : options.idempotencyKey)
                : options === null || options === void 0 ? void 0 : options.idempotencyKey;
            if (idempotencyKey) {
                headers['Idempotency-Key'] = idempotencyKey;
            }
            return headers;
        });
    }
}
exports.SdkHttpClient = SdkHttpClient;
