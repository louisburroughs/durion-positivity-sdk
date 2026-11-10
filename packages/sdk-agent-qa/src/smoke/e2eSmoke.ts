/**
 * End-to-end smoke of the whole stack, with no model provider and no backend.
 *
 *   npm run smoke -w @durion-sdk/agent-qa
 *
 * A scripted `MockLanguageModelV4` plays the model and a local HTTP server
 * plays the gateway; everything between them is real — the AI SDK adapter, the
 * loop, Zod validation, the tool runtime, the built `@durion-sdk/*` clients and
 * the transport's headers. It exists because the unit suites cannot cover the
 * adapter: `ai` is ESM-only and Jest's CommonJS runtime cannot load it, so this
 * runs under plain Node instead (it needs the root `npm run build` first).
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockLanguageModelV4 } from 'ai/test';
import { AiSdkModel } from '../agent/aiSdkModel';
import { buildCatalog } from '../catalog/buildCatalog';
import { CoverageStore } from '../coverage/CoverageStore';
import { CallLedger } from '../ledger/CallLedger';
import { runScenario } from '../runner/runScenario';
import { scenarioSchema } from '../scenarios/types';
import { SdkInvoker } from '../sdk/SdkInvoker';

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  correlationId?: string;
}

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

const toolCall = (id: string, toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage,
  warnings: [],
});

async function main(): Promise<void> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    seen.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers['authorization'],
      correlationId: request.headers['x-correlation-id'] as string | undefined,
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/location/v1/locations') {
      response.end(JSON.stringify([{ id: '0190aaaa-0000-7000-8000-000000000001', name: 'Main Street' }]));
    } else if (request.url?.startsWith('/order/v1/orders/')) {
      response.statusCode = 404;
      response.end(JSON.stringify({ code: 'ORDER_NOT_FOUND', message: 'no such order' }));
    } else {
      response.statusCode = 500;
      response.end(JSON.stringify({ code: 'UNEXPECTED_ROUTE', message: request.url }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const mock = new MockLanguageModelV4({
      doGenerate: [
        toolCall('c1', 'location__LocationAPIApi__listLocations', {}),
        // Wrong on purpose: sdk_call without an operationId must come back as a correctable result.
        toolCall('c2', 'sdk_call', { input: {} }),
        toolCall('c3', 'sdk_call', {
          operationId: 'order.SalesOrdersApi.getOrder',
          input: { orderId: '0190bbbb-0000-7000-8000-000000000002' },
        }),
        toolCall('c4', 'finish', { verdict: 'completed', summary: 'listed locations; the order lookup answered 404' }),
      ],
    });

    const catalog = buildCatalog();
    const ledger = new CallLedger();
    const coverage = CoverageStore.inMemory(new Date().toISOString().slice(0, 7));
    const scenario = scenarioSchema.parse({
      id: 'smoke',
      title: 'Smoke',
      cadence: 'daily',
      at: '09:00',
      persona: 'admin',
      kind: 'error',
      goal: 'List locations, then look up an order that does not exist.',
      operations: ['location.LocationAPIApi.listLocations'],
      expect: [
        { kind: 'call', operation: 'location.LocationAPIApi.listLocations', outcome: 'success' },
        { kind: 'http', statuses: [404], operations: ['order.SalesOrdersApi.getOrder'] },
      ],
    });

    const result = await runScenario(scenario, {
      catalog,
      invoker: new SdkInvoker({ baseUrlFor: (pkg) => `${baseUrl}/${pkg}`, tokenFor: async () => 'smoke-token' }),
      ledger,
      coverage,
      policy: { mode: 'mutating', allowDestructive: false, deny: [] },
      model: new AiSdkModel({ chain: [{ provider: 'custom', model: 'mock' }], resolve: () => mock, maxRetries: 0 }),
      limits: { maxSteps: 10, timeoutMs: 30_000, maxTokens: 100_000, maxCalls: 10 },
      personas: ['admin'],
      roleMode: false,
      runId: 'qa-smoke',
      prompt: { tenantSlug: 'smoke', date: '2026-01-05', time: '09:00', timeZone: 'UTC', runTag: 'qa-smoke' },
      log: () => undefined,
    });

    assert.equal(result.verdict, 'passed', `verdict: ${result.verdict} — ${result.reasons.join('; ')}`);
    assert.equal(result.loop?.status, 'finished');
    assert.equal(result.loop?.steps, 4);
    assert.deepEqual(result.callsByStatus, { '200': 1, '404': 1 });
    assert.deepEqual(
      seen.map((entry) => `${entry.method} ${entry.url}`),
      ['GET /location/v1/locations', 'GET /order/v1/orders/carts/0190bbbb-0000-7000-8000-000000000002'],
    );
    assert.ok(seen.every((entry) => entry.authorization === 'Bearer smoke-token'), 'transport must send the bearer token');
    assert.ok(seen.every((entry) => entry.correlationId), 'transport must send X-Correlation-Id');
    assert.equal(ledger.all()[1]?.errorCode, 'ORDER_NOT_FOUND');
    assert.ok(coverage.isCalled('location.LocationAPIApi.listLocations') && coverage.isCalled('order.SalesOrdersApi.getOrder'));

    // The model was offered the pinned tool and the catalog tools, and saw each result before its next turn.
    const [first, , third] = mock.doGenerateCalls;
    const offered = (first.tools ?? []).map((tool) => tool.name);
    for (const name of ['location__LocationAPIApi__listLocations', 'sdk_search', 'sdk_describe', 'sdk_call', 'finish']) {
      assert.ok(offered.includes(name), `tool ${name} was not offered to the model`);
    }
    const lastMessage = JSON.stringify(third.prompt[third.prompt.length - 1]);
    assert.ok(lastMessage.includes('invalid-input'), 'the rejected tool input must be fed back to the model');

    console.log(`smoke ok: ${result.loop?.steps} steps, calls ${JSON.stringify(result.callsByStatus)}, ${offered.length} tools offered`);
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
