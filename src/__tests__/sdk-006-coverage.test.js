"use strict";
/**
 * SDK-006 Coverage: DurionSdkError constructor behavioral tests.
 *
 * Exercises the constructor body of DurionSdkError (error.ts lines 27-32)
 * to lift statement/branch/function/line coverage to 100%.
 *
 * Issue: SDK-006
 */
Object.defineProperty(exports, "__esModule", { value: true });
const error_1 = require("../../packages/sdk-transport/src/error");
describe('DurionSdkError', () => {
    const mockError = {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        status: 404,
        timestamp: '2024-01-01T00:00:00Z',
        correlationId: 'corr-123',
    };
    const mockResponse = new Response(null, { status: 404 });
    it('is an instance of Error', () => {
        const err = new error_1.DurionSdkError(mockResponse, mockError);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(error_1.DurionSdkError);
    });
    it('message includes status, code, and message from DurionApiError', () => {
        const err = new error_1.DurionSdkError(mockResponse, mockError);
        expect(err.message).toBe('DurionSdkError [404] NOT_FOUND: Resource not found');
        expect(err.name).toBe('DurionSdkError');
    });
    it('exposes readonly response and error properties', () => {
        const err = new error_1.DurionSdkError(mockResponse, mockError);
        expect(err.response).toBe(mockResponse);
        expect(err.error).toBe(mockError);
    });
});
