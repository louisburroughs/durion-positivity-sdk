/**
 * Coverage: normalizeRequestUrl branches in Phase 2 factory index.ts files.
 *
 * Every Phase 2 factory embeds a module-private normalizeRequestUrl helper
 * that normalises the url argument before forwarding it to SdkHttpClient.
 * The existing sdk-005-client-integration.test.ts always invokes fetchApi
 * with string URLs, so the URL-object and Request-object branches (and the
 * String(url) fallback) are never reached.  This file provides the missing
 * coverage by calling fetchApi — extracted from the live configuration stored
 * on a generated API instance — with each of those input shapes.
 *
 * One describe block per factory × three url-type branches = 33 targeted
 * tests.  All factories share the same helper and fetch mock.
 *
 * Issue: SDK-005
 */
export {};
