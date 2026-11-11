/**
 * Today's roster and what each visit has learned so far, on disk.
 *
 * The roster itself could be regenerated at any time (it is a function of the
 * date and the seed), but it is written once and read back so that a settings
 * change at noon cannot swap the customers a morning intake was run for. The
 * memory beside it is what lets the checkout at 3pm find the workorder the
 * intake created at 9am, in another process.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildDayPlan, type DayPlan, type DayPlanOptions, type Visit, type VisitStage } from './dayPlan';
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

  /** Opens the plan for `date`, generating and saving it on first use. */
  static open(dayDir: string, date: string, options: DayPlanOptions): DayPlanStore {
    const file = path.join(dayDir, 'day-plan.json');
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DayFile>;
        if (parsed.plan?.date === date && Array.isArray(parsed.plan.visits)) {
          return new DayPlanStore(file, { plan: parsed.plan, memory: parsed.memory ?? {} });
        }
      } catch {
        // Fall through and regenerate: the roster is deterministic, only the memory is lost.
      }
    }
    const store = new DayPlanStore(file, { plan: buildDayPlan(date, options), memory: {} });
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
