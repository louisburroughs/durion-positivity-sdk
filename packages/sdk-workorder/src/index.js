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
exports.WorkorderChangeRequestWorkflow = exports.WorkorderEstimateWorkflow = void 0;
exports.createWorkorderClient = createWorkorderClient;
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
function createWorkorderClient(config) {
    const httpClient = new transport_1.SdkHttpClient(config);
    const configuration = new runtime_1.Configuration({
        basePath: config.baseUrl,
        fetchApi: (url, init) => __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const method = ((_a = init === null || init === void 0 ? void 0 : init.method) !== null && _a !== void 0 ? _a : 'GET').toUpperCase();
            const mergedHeaders = new Headers(init === null || init === void 0 ? void 0 : init.headers);
            const sdkHeaders = yield httpClient.buildRequestHeaders(method, {
                url: normalizeRequestUrl(url),
                idempotencyKey: (_b = mergedHeaders.get('Idempotency-Key')) !== null && _b !== void 0 ? _b : undefined,
            });
            Object.entries(sdkHeaders).forEach(([key, value]) => {
                mergedHeaders.set(key, value);
            });
            return fetch(url, Object.assign(Object.assign({}, init), { headers: mergedHeaders }));
        }),
    });
    return {
        approvalConfigurationAPIApi: new GeneratedApis.ApprovalConfigurationAPIApi(configuration),
        changeRequestAPIApi: new GeneratedApis.ChangeRequestAPIApi(configuration),
        dailyDispatchBoardDashboardApi: new GeneratedApis.DailyDispatchBoardDashboardApi(configuration),
        estimateAPIApi: new GeneratedApis.EstimateAPIApi(configuration),
        estimateSearchApi: new GeneratedApis.EstimateSearchApi(configuration),
        estimatesFromAppointmentsApi: new GeneratedApis.EstimatesFromAppointmentsApi(configuration),
        operationalContextApi: new GeneratedApis.OperationalContextApi(configuration),
        substituteLinkControllerApi: new GeneratedApis.SubstituteLinkControllerApi(configuration),
        technicianAssignmentAPIApi: new GeneratedApis.TechnicianAssignmentAPIApi(configuration),
        timeEntryAPIApi: new GeneratedApis.TimeEntryAPIApi(configuration),
        travelSegmentAPIApi: new GeneratedApis.TravelSegmentAPIApi(configuration),
        wipDashboardApi: new GeneratedApis.WIPDashboardApi(configuration),
        workOrderAPIApi: new GeneratedApis.WorkOrderAPIApi(configuration),
        workSessionAPIApi: new GeneratedApis.WorkSessionAPIApi(configuration),
        workexecTimeTrackingAPIApi: new GeneratedApis.WorkexecTimeTrackingAPIApi(configuration),
        workorderDetailApi: new GeneratedApis.WorkorderDetailApi(configuration),
        workorderLaborAPIApi: new GeneratedApis.WorkorderLaborAPIApi(configuration),
        workorderPartAdjustmentsApi: new GeneratedApis.WorkorderPartAdjustmentsApi(configuration),
        workorderPartsUsageApi: new GeneratedApis.WorkorderPartsUsageApi(configuration),
        workorderPickFacadeApi: new GeneratedApis.WorkorderPickFacadeApi(configuration),
        workorderPickedItemsApi: new GeneratedApis.WorkorderPickedItemsApi(configuration),
    };
}
var workorderEstimateWorkflow_1 = require("./workflows/workorderEstimateWorkflow");
Object.defineProperty(exports, "WorkorderEstimateWorkflow", { enumerable: true, get: function () { return workorderEstimateWorkflow_1.WorkorderEstimateWorkflow; } });
var workorderChangeRequestWorkflow_1 = require("./workflows/workorderChangeRequestWorkflow");
Object.defineProperty(exports, "WorkorderChangeRequestWorkflow", { enumerable: true, get: function () { return workorderChangeRequestWorkflow_1.WorkorderChangeRequestWorkflow; } });
__exportStar(require("./runtime"), exports);
__exportStar(require("./apis/index"), exports);
__exportStar(require("./models/index"), exports);
