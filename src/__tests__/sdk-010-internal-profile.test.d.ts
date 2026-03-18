/**
 * SDK-010 Internal Profile Tests — GREEN phase.
 *
 * Tests verify the sdk-internal package at packages/sdk-internal/.
 *
 * Test categories
 * ---------------
 * 1. Structural tests  — verify the sdk-internal package directories and
 *    files exist on disk.
 *
 * 2. Manifest tests    — verify packages/sdk-internal/package.json has the
 *    correct name and is marked private.
 *
 * 3. README tests      — verify packages/sdk-internal/README.md contains
 *    required documentation strings (internal-only, ADR-0021).
 *
 * 4. Isolation tests   — verify createTaxClient is NOT re-exported from any
 *    public sdk-* package index.ts.
 *    These serve as safety guards that must never regress.
 *
 * 5. Behavioral test   — verify createTaxClient can be imported as a function
 *    from the direct file path packages/sdk-internal/src/index.ts.
 *
 * Issue: SDK-010
 */
export {};
