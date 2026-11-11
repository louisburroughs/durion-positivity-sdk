/**
 * Jobs that span two days.
 *
 * A part the shop does not stock is ordered on the day the customer comes in
 * and delivered the next day the shop is open. So a special-order visit stops,
 * on its first day, once the part is on order — and is picked up again the next
 * morning as a continuation: the delivery is received against the workorder,
 * the job is done, and the customer comes back to collect and pay.
 *
 * The continuation is built when the next day's plan is made, from the most
 * recent earlier plan on disk. It keeps everything the first day learned (the
 * visit's memory: customer, vehicle, workorder, purchase order, part line), so
 * the second day's stages are told what they need rather than rediscovering it.
 *
 * "The next day the shop is open" is whichever day the harness next makes a
 * plan — a Saturday job continues on Monday, and a job ordered before a day the
 * harness did not run continues when it runs again, up to {@link MAX_GAP_DAYS}.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SeederRandom } from '@durion-sdk/seeder';
import { clockToMinutes, daySeed, minutesToClock, type DayPlanOptions, type Visit } from './dayPlan';
import { DayPlanStore } from './DayPlanStore';
import type { VisitMemory } from './visitScenarios';

/** A delivery this late is not coming: the job is left for a person to chase. */
export const MAX_GAP_DAYS = 7;

export interface CarriedVisit {
  visit: Visit;
  memory: VisitMemory;
}

const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/**
 * The continuation of one special-order visit on `date`: the delivery in the
 * morning, then the work, then the customer's return.
 */
export function continueVisit(visit: Visit, origin: string, date: string, options: DayPlanOptions): Visit {
  const random = new SeederRandom(daySeed(`${date}|carry|${visit.id}`, options.seed));
  const open = clockToMinutes(options.openTime);
  const close = clockToMinutes(options.closeTime);
  // Vendor trucks come in the morning.
  const receive = Math.min(open + random.int(15, 120), close - 120);
  const work = Math.min(receive + random.int(20, 45), close - 60);
  const checkout = Math.min(work + random.int(60, 150), close - 15);
  // The id says which day the job began, so it cannot collide with one of today's new visits.
  const [, month, day] = origin.split('-');
  const number = visit.id.slice(visit.id.lastIndexOf('-v'));
  const id = `${visit.site.slug}-d${month}${day}${number}`;
  return {
    ...visit,
    id,
    carriedFrom: origin,
    stages: [
      { id: `${id}-receive`, name: 'receive', at: minutesToClock(receive) },
      { id: `${id}-work`, name: 'work', at: minutesToClock(work) },
      { id: `${id}-checkout`, name: 'checkout', at: minutesToClock(checkout) },
    ],
  };
}

/**
 * The visits to continue on `date`: special-order jobs from the most recent
 * earlier plan that got as far as a workorder and were not themselves
 * continuations.
 *
 * Only the most recent plan is read, and each plan is the most recent for
 * exactly one later day, so a job is continued once.
 */
export function carriedVisits(runsDir: string, date: string, options: DayPlanOptions): CarriedVisit[] {
  if (!fs.existsSync(runsDir)) {
    return [];
  }
  const earlier = fs
    .readdirSync(runsDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < date)
    .sort()
    .reverse();
  for (const origin of earlier) {
    if (dayNumber(date) - dayNumber(origin) > MAX_GAP_DAYS) {
      break;
    }
    const previous = DayPlanStore.load(path.join(runsDir, origin), origin);
    if (!previous) {
      continue;
    }
    return previous.plan.visits
      .filter((visit) => visit.parts === 'special-order' && !visit.carriedFrom && visit.stages.some((stage) => stage.name === 'order'))
      .map((visit) => ({ visit, memory: previous.memoryOf(visit.id) }))
      // No workorder means the customer declined or the intake never completed: nothing to continue.
      .filter(({ memory }) => Boolean(memory['workorderId']))
      .map(({ visit, memory }) => ({ visit: continueVisit(visit, origin, date, options), memory: { ...memory } }));
  }
  return [];
}
