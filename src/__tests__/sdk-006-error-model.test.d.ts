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
export {};
