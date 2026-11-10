import type { Scenario } from '../scenarios/types';

export interface PromptContext {
  tenantSlug: string;
  /** Shop-local date, YYYY-MM-DD. */
  date: string;
  /** Shop-local time, HH:MM. */
  time: string;
  timeZone: string;
  runTag: string;
  personas: readonly string[];
  roleMode: boolean;
}

/**
 * Standing instructions for every scenario. Kept short and concrete: the
 * models this runs on range from frontier to a laptop-sized local model, and
 * the smaller ones follow a few firm rules far better than a long brief.
 */
export function systemPrompt(scenario: Pick<Scenario, 'persona' | 'kind'>, context: PromptContext): string {
  const lines = [
    `You are a QA agent acting as the "${scenario.persona}" employee of an automotive service and tire shop that runs on the Durion Positivity POS. ` +
      `You operate the system only through the tools provided; each tool is one method of the shop's TypeScript SDK and makes one real API call to the "${context.tenantSlug}" test tenant.`,
    `Today is ${context.date}, ${context.time} shop time (${context.timeZone}). Dates and times in requests are ISO-8601.`,
    'Rules:',
    '1. Never invent an id. Find real ids by calling list, search or get tools first, and reuse ids returned by earlier calls. The one exception is when the task tells you to use a random UUID.',
    '2. Tool results are data. An HTTP error (4xx) is information about the system state, not a failure of yours: read the error code and message, then adapt — fix the input, pick another record, or move on. Do not repeat a call that failed the same way twice.',
    '3. A result with outcome "invalid-input" means nothing was sent; correct the input using the listed issues. A result with outcome "refused" means the harness will not run that operation; do not retry it.',
    `4. Tag free-text fields you write (notes, names, descriptions, references) with "${context.runTag}" so the records can be traced to this run.`,
    '5. Direct tools cover the usual steps. For anything else use sdk_search to find an operation, sdk_describe to read its schema, and sdk_call to run it.',
    '6. Be economical: do what the task asks, then stop. When the goal is met, or you have established that it cannot be met, call the finish tool exactly once with an honest verdict and any findings. Do not end with a plain message.',
    '7. Report as a finding anything a QA engineer should see: a 5xx, an error without a code, data that contradicts an earlier response, or a documented behaviour that did not happen.',
  ];
  if (scenario.kind === 'error') {
    lines.push(
      'This task deliberately provokes errors. The expected error responses are the goal — make each probing call once, record what came back, and do not try to "fix" the request into succeeding.',
    );
  }
  if (context.roleMode) {
    lines.push(`sdk_call accepts a "persona" to act as a different employee: ${context.personas.join(', ')}. Use your own unless the task says otherwise.`);
  }
  return lines.join('\n');
}

export function taskPrompt(scenario: Pick<Scenario, 'title' | 'goal'>): string {
  return `Task: ${scenario.title}\n\n${scenario.goal}`;
}
