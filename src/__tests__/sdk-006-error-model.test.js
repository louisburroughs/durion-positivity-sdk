"use strict";
/**
 * SDK-006 Standard Error Model — RED phase acceptance tests.
 *
 * Verifies that the shared transport package exports a standard error model
 * satisfying the acceptance criteria defined in Story SDK-006:
 *
 *   DurionApiError — interface mirroring ApiError.java with fields:
 *     code, message, status, timestamp, correlationId,
 *     fieldErrors?, referenceId?, nextAction?, supportAction?
 *
 *   DurionSdkError — class extending Error with (response, error) constructor
 *
 * All tests probe packages/sdk-transport/src/error.ts (structural) and
 * packages/sdk-transport/src/index.ts (re-export guard).  All tests fail RED
 * intentionally because error.ts does not yet exist.
 *
 * Issue: SDK-006
 */
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
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// __dirname resolves to src/__tests__; repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');
const TRANSPORT_SRC = path.join(REPO_ROOT, 'packages', 'sdk-transport', 'src');
const ERROR_TS_PATH = path.join(TRANSPORT_SRC, 'error.ts');
const INDEX_TS_PATH = path.join(TRANSPORT_SRC, 'index.ts');
function readText(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}
// ---------------------------------------------------------------------------
// AC-1 — packages/sdk-transport/src/error.ts exists.
//
//         The file does not yet exist, so this test fails RED.
// ---------------------------------------------------------------------------
describe('SDK-006 AC-1: packages/sdk-transport/src/error.ts exists', () => {
    it('error.ts file exists in packages/sdk-transport/src/', () => {
        expect(fs.existsSync(ERROR_TS_PATH)).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-2 — error.ts exports DurionApiError.
//
//         File does not exist yet, so both tests fail RED.
// ---------------------------------------------------------------------------
describe('SDK-006 AC-2: error.ts exports DurionApiError', () => {
    it('error.ts exists (prerequisite for content checks)', () => {
        expect(fs.existsSync(ERROR_TS_PATH)).toBe(true);
    });
    it('error.ts contains an export declaration for DurionApiError', () => {
        expect(fs.existsSync(ERROR_TS_PATH)).toBe(true);
        const content = readText(ERROR_TS_PATH);
        expect(content).toMatch(/export\b.*\bDurionApiError\b/);
    });
});
// ---------------------------------------------------------------------------
// AC-3 — DurionApiError interface declares all required fields from ApiError.java.
//
//         File does not exist yet, so all field-level tests fail RED.
// ---------------------------------------------------------------------------
describe('SDK-006 AC-3: DurionApiError has all required fields', () => {
    const REQUIRED_FIELDS = [
        'code',
        'message',
        'status',
        'timestamp',
        'correlationId',
    ];
    it.each(REQUIRED_FIELDS)('DurionApiError declares required field "%s"', (field) => {
        expect(fs.existsSync(ERROR_TS_PATH)).toBe(true);
        const content = readText(ERROR_TS_PATH);
        // Each field must appear as an interface or type property declaration.
        expect(content).toContain(field);
    });
});
// ---------------------------------------------------------------------------
// AC-4 — error.ts exports DurionSdkError.
//
//         File does not exist yet, so this test fails RED.
// ---------------------------------------------------------------------------
describe('SDK-006 AC-4: error.ts exports DurionSdkError', () => {
    it('error.ts contains an export declaration for DurionSdkError', () => {
        expect(fs.existsSync(ERROR_TS_PATH)).toBe(true);
        const content = readText(ERROR_TS_PATH);
        expect(content).toMatch(/export\b.*\bDurionSdkError\b/);
    });
});
// ---------------------------------------------------------------------------
// AC-5 — DurionSdkError extends Error.
//
//         File does not exist yet, so this test fails RED.
// ---------------------------------------------------------------------------
describe('SDK-006 AC-5: DurionSdkError extends Error', () => {
    it('DurionSdkError class declaration contains "extends Error"', () => {
        expect(fs.existsSync(ERROR_TS_PATH)).toBe(true);
        const content = readText(ERROR_TS_PATH);
        expect(content).toContain('extends Error');
    });
});
// ---------------------------------------------------------------------------
// AC-6 — DurionSdkError constructor accepts response and error parameters.
//
//         File does not exist yet, so both tests fail RED.
// ---------------------------------------------------------------------------
describe('SDK-006 AC-6: DurionSdkError has response and error constructor parameters', () => {
    it('DurionSdkError constructor includes a "response" parameter or readonly field', () => {
        expect(fs.existsSync(ERROR_TS_PATH)).toBe(true);
        const content = readText(ERROR_TS_PATH);
        expect(content).toContain('response');
    });
    it('DurionSdkError constructor includes an "error" parameter or readonly field', () => {
        expect(fs.existsSync(ERROR_TS_PATH)).toBe(true);
        const content = readText(ERROR_TS_PATH);
        // Check for 'error' as a distinct word to capture constructor param / readonly property
        // (distinct from the class name DurionSdkError itself).
        expect(content).toMatch(/\berror\b/);
    });
});
// ---------------------------------------------------------------------------
// AC-7 — packages/sdk-transport/src/index.ts re-exports both DurionApiError
//         and DurionSdkError so consumers can import them from the package root.
//
//         error.ts does not yet exist, so the index.ts cannot re-export from
//         it; the content assertions fail RED.
// ---------------------------------------------------------------------------
describe('SDK-006 AC-7: sdk-transport/src/index.ts re-exports DurionApiError and DurionSdkError', () => {
    it('packages/sdk-transport/src/index.ts exists', () => {
        expect(fs.existsSync(INDEX_TS_PATH)).toBe(true);
    });
    it('index.ts re-exports DurionApiError', () => {
        expect(fs.existsSync(INDEX_TS_PATH)).toBe(true);
        const content = readText(INDEX_TS_PATH);
        expect(content).toMatch(/\bDurionApiError\b/);
    });
    it('index.ts re-exports DurionSdkError', () => {
        expect(fs.existsSync(INDEX_TS_PATH)).toBe(true);
        const content = readText(INDEX_TS_PATH);
        expect(content).toMatch(/\bDurionSdkError\b/);
    });
});
