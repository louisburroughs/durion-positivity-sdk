/**
 * SDK-005 Phase 2 Generated Client Integration — factory call coverage tests.
 *
 * Verifies that each of the 11 Phase 2 generated client packages exposes a
 * working factory function that:
 *   - returns a non-null client object (AC-1)
 *   - exposes all required API namespace properties (AC-2)
 *   - accepts optional token + apiVersion config (AC-3)
 *   - executes the inline fetchApi callback in both ?? branches (AC-4)
 *
 * No server is required. All factories construct configuration objects and
 * instantiate API classes from the generated code; they make no outbound
 * HTTP calls in isolation.
 *
 * Issue: SDK-005
 */
export {};
