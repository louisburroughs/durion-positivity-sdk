/**
 * The day's report, rebuilt from the result files after every scenario so it
 * is always current, whichever process ran last.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describeVisit, type Visit } from '../day/dayPlan';
import type { Site } from '../day/sites';
import type { CoverageSummary } from '../sdk-coverage/CoverageStore';
import type { ScenarioResult } from './runScenario';

const MARK: Record<string, string> = {
  passed: 'PASS',
  failed: 'FAIL',
  inconclusive: 'INCONCLUSIVE',
  infra: 'INFRA',
  skipped: 'SKIPPED',
};

export function readDayResults(dayDir: string): ScenarioResult[] {
  if (!fs.existsSync(dayDir)) {
    return [];
  }
  return fs
    .readdirSync(dayDir)
    .filter((file) => /^\d{4}-.+\.json$/.test(file))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dayDir, file), 'utf8')) as ScenarioResult);
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

export function renderReport(
  date: string,
  results: readonly ScenarioResult[],
  coverage: CoverageSummary,
  visits: readonly Visit[] = [],
  sites: readonly Site[] = [],
): string {
  const count = (verdict: string): number => results.filter((result) => result.verdict === verdict).length;
  const tokens = results.reduce((sum, result) => sum + (result.loop ? result.loop.usage.inputTokens + result.loop.usage.outputTokens : 0), 0);
  const calls = results.reduce((sum, result) => sum + Object.values(result.callsByStatus).reduce((a, b) => a + b, 0), 0);
  const lines: string[] = [
    `# Agent QA — ${date}`,
    '',
    `${results.length} scenarios: ${count('passed')} passed, ${count('failed')} failed, ${count('inconclusive')} inconclusive, ` +
      `${count('infra')} infra, ${count('skipped')} skipped. ${calls} SDK calls, ${tokens.toLocaleString('en-US')} tokens.`,
    '',
    '| Time (UTC) | Scenario | Cadence | Verdict | Calls by status | Steps | Model |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of results) {
    const statuses = Object.entries(result.callsByStatus)
      .map(([status, n]) => `${status}×${n}`)
      .join(' ');
    lines.push(
      `| ${result.startedAt.slice(11, 16)} | ${cell(result.scenarioId)} | ${result.cadence} | ${MARK[result.verdict] ?? result.verdict} | ` +
        `${statuses || '—'} | ${result.loop?.steps ?? '—'} | ${cell(result.loop?.models.join(', ') || '—')} |`,
    );
  }

  if (sites.length > 0) {
    const verdictOf = new Map(results.map((result) => [result.scenarioId, result.verdict]));
    const count = (list: readonly Visit[], test: (visit: Visit) => boolean): number => list.filter(test).length;
    lines.push(
      '',
      "## Today's customers, by site",
      '',
      `${visits.length} visits across ${sites.length} site(s): ${count(visits, (visit) => visit.customer.status === 'new')} new and ` +
        `${count(visits, (visit) => visit.customer.status === 'existing')} returning customers; ` +
        `${count(visits, (visit) => visit.customer.type === 'commercial')} commercial and ` +
        `${count(visits, (visit) => visit.customer.type === 'individual')} individual.`,
    );
    for (const site of sites) {
      const here = visits.filter((visit) => visit.site.id === site.id);
      lines.push(
        '',
        `### ${site.name} (${site.code}) — ${site.positions} position(s), ${here.length} visit(s)`,
        '',
        `${count(here, (visit) => visit.customer.status === 'new')} new, ${count(here, (visit) => visit.customer.status === 'existing')} returning; ` +
          `${count(here, (visit) => visit.customer.type === 'commercial')} commercial, ${count(here, (visit) => visit.customer.type === 'individual')} individual.`,
      );
      if (here.length > 0) {
        lines.push('', '| Visit | Customer and vehicle | Stages |', '| --- | --- | --- |');
      }
      for (const visit of here) {
        const stages = visit.stages
          .map((stage) => `${stage.at} ${stage.name}: ${MARK[verdictOf.get(stage.id) ?? ''] ?? 'pending'}`)
          .join(' · ');
        lines.push(`| ${visit.id} | ${cell(describeVisit(visit).replace(`${site.name} — `, ''))} | ${stages} |`);
      }
    }
  }

  const failed = results.filter((result) => result.verdict === 'failed');
  if (failed.length > 0) {
    lines.push('', '## Server errors and undecodable responses', '');
    for (const result of failed) {
      for (const error of result.serverErrors) {
        lines.push(
          `- **${result.scenarioId}** — \`${error.operationId}\` answered ${error.status}${error.errorCode ? ` ${error.errorCode}` : ''}` +
            `${error.requestPath ? ` on \`${error.requestPath}\`` : ''}${error.correlationId ? ` (X-Correlation-Id \`${error.correlationId}\`)` : ''}`,
        );
      }
    }
  }

  const attention = results.filter((result) => result.verdict !== 'passed' && result.verdict !== 'failed' && result.reasons.length > 0);
  if (attention.length > 0) {
    lines.push('', '## Not conclusive', '');
    for (const result of attention) {
      lines.push(`- **${result.scenarioId}** (${result.verdict}) — ${result.reasons.map(cell).join('; ')}`);
    }
  }

  const findings = results.flatMap((result) =>
    (result.finish?.findings ?? [])
      .filter((finding) => finding.severity !== 'info')
      .map((finding) => `- **${result.scenarioId}** [${finding.severity}]${finding.operationId ? ` \`${finding.operationId}\`` : ''} — ${cell(finding.description)}`),
  );
  if (findings.length > 0) {
    lines.push('', '## Agent findings (unverified)', '', ...findings);
  }

  lines.push(
    '',
    `## Coverage for ${coverage.month}`,
    '',
    `${coverage.unitsCalled}/${coverage.unitsTotal} ${coverage.level}s called this month.`,
    '',
    '| Package | Reachable | Operations called | API classes called |',
    '| --- | --- | --- | --- |',
  );
  for (const pkg of coverage.packages) {
    lines.push(
      `| ${pkg.pkg} | ${pkg.reachable ? 'yes' : 'no'} | ${pkg.operationsCalled}/${pkg.operations} | ${pkg.apisCalled}/${pkg.apis} |`,
    );
  }
  if (coverage.missing.length > 0) {
    const shown = coverage.missing.slice(0, 40);
    lines.push('', `Not yet called (${coverage.missing.length}): ${shown.map((unit) => `\`${unit}\``).join(', ')}${coverage.missing.length > shown.length ? ', …' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
