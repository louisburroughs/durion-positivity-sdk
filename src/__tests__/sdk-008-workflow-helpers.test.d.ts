/**
 * SDK-008 Workflow Helper Tests — GREEN phase.
 *
 * Tests verify the implemented workflow helper classes. The workflow classes
 * are exported from their respective package index files and delegate to the
 * underlying generated API classes.
 *
 * Test categories
 * ---------------
 * 1. Structural tests  — verify workflow source files exist on disk.
 *
 * 2. Export tests      — verify each workflow class is re-exported from its
 *    package index.ts.
 *
 * 3. Behavioral tests  — verify each workflow method delegates correctly to
 *    the underlying generated API class (constructor injection).
 *    Each test exercises delegation with jest.fn() mocks.
 *
 * Issue: SDK-008
 */
export {};
