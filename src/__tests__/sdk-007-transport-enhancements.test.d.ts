/**
 * SDK-007 Transport Enhancements — RED phase acceptance tests.
 *
 * Verifies that DurionSdkConfig and SdkHttpClient satisfy the acceptance
 * criteria defined in Story SDK-007:
 *
 *   correlationIdProvider?: () => string
 *     Added to DurionSdkConfig; SdkHttpClient.buildRequestHeaders() and
 *     request() must call it instead of falling back immediately to
 *     crypto.randomUUID().
 *
 *   idempotencyKeyGenerator?: (method: string, url: string) => string
 *     Added to DurionSdkConfig for future per-call idempotency key generation.
 *
 * Structural tests (AC-1 through AC-4) read packages/sdk-transport/src/config.ts
 * and fail RED because neither field is present in the current interface.
 *
 * Behavioral tests (AC-5 and AC-6) instantiate SdkHttpClient with a provider
 * mock and assert that the mock is invoked; they fail RED because
 * buildRequestHeaders() and request() currently call crypto.randomUUID()
 * unconditionally.
 *
 * AC-7 is a regression baseline: it asserts the existing fallback to
 * crypto.randomUUID() and PASSES even in RED phase (documents existing behavior).
 *
 * Issue: SDK-007
 */
export {};
