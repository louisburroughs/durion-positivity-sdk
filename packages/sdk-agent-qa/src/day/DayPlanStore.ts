/**
 * Today's roster and what each visit has learned so far, on disk.
 *
 * The roster is made once each morning, from the sites the tenant has that day,
 * and read back from then on, so that neither a settings change nor a site
 * added at noon can swap the customers a morning intake was run for. The
 * memory beside it is what lets the checkout at 3pm find the workorder the
 * intake created at 9am, in another process.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildDayPlan, type DayPlan, type DayPlanOptions, type Visit, type VisitStage } from './dayPlan';
import type { Site } from './sites';
import type { VisitMemory } from './visitScenarios';

interface DayFile {
  plan: DayPlan;
  memory: Record<string, VisitMemory>;
}

export class DayPlanStore {
  private constructor(
    private readonly file: string,
    private data: DayFile,
  ) {}

  /** Today's plan if one has been made, otherwise undefined. */
  static load(dayDir: string, date: string): DayPlanStore | undefined {
    const file = path.join(dayDir, 'day-plan.json');
    if (!fs.existsSync(file)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DayFile>;
      if (parsed.plan?.date === date && Array.isArray(parsed.plan.visits) && Array.isArray(parsed.plan.sites)) {
        return new DayPlanStore(file, { plan: parsed.plan, memory: parsed.memory ?? {} });
      }
    } catch {
      // Unreadable: treated as not made yet. The roster is deterministic; only the memory is lost.
    }
    return undefined;
  }

  /**
   * Makes and saves the plan for `date` across the given sites: today's new
   * visits, plus any jobs carried over from an earlier day with what they had
   * already established.
   */
  static create(
    dayDir: string,
    date: string,
    sites: readonly Site[],
    options: DayPlanOptions,
    carried: ReadonlyArray<{ visit: Visit; memory: VisitMemory }> = [],
  ): DayPlanStore {
    const plan = buildDayPlan(date, sites, options);
    const memory: Record<string, VisitMemory> = {};
    for (const entry of carried) {
      plan.visits.push(entry.visit);
      memory[entry.visit.id] = { ...entry.memory };
    }
    const store = new DayPlanStore(path.join(dayDir, 'day-plan.json'), { plan, memory });
    store.save();
    return store;
  }

  get plan(): DayPlan {
    return this.data.plan;
  }

  /** The stage with this id and the visit it belongs to. */
  find(stageId: string): { visit: Visit; stage: VisitStage; index: number } | undefined {
    for (const visit of this.data.plan.visits) {
      const index = visit.stages.findIndex((stage) => stage.id === stageId);
      if (index >= 0) {
        return { visit, stage: visit.stages[index], index };
      }
    }
    return undefined;
  }

  /** The live memory object for a visit: mutate it, then {@link save}. */
  memoryOf(visitId: string): VisitMemory {
    return (this.data.memory[visitId] ??= {});
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.file);
  }
}
