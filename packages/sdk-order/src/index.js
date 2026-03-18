"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrderClient = createOrderClient;
/* tslint:disable */
/* eslint-disable */
const transport_1 = require("@durion-sdk/transport");
const runtime_1 = require("./runtime");
const GeneratedApis = __importStar(require("./apis"));
function normalizeRequestUrl(url) {
    if (typeof url === 'string') {
        return url;
    }
    if (url instanceof URL) {
        return url.toString();
    }
    if (typeof Request !== 'undefined' && url instanceof Request) {
        return url.url;
    }
    return String(url);
}
function createOrderClient(config) {
    const httpClient = new transport_1.SdkHttpClient(config);
    const configuration = new runtime_1.Configuration({
        basePath: config.baseUrl,
        fetchApi: async (url, init) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            const mergedHeaders = new Headers(init?.headers);
            const sdkHeaders = await httpClient.buildRequestHeaders(method, {
                url: normalizeRequestUrl(url),
                idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
            });
            Object.entries(sdkHeaders).forEach(([key, value]) => {
                mergedHeaders.set(key, value);
            });
            return fetch(url, { ...init, headers: mergedHeaders });
        },
    });
    return {
        orderCancellationApi: new GeneratedApis.OrderCancellationApi(configuration),
        priceOverridesApi: new GeneratedApis.PriceOverridesApi(configuration),
        salesOrdersApi: new GeneratedApis.SalesOrdersApi(configuration),
    };
}
__exportStar(require("./runtime"), exports);
__exportStar(require("./apis/index"), exports);
__exportStar(require("./models/index"), exports);
