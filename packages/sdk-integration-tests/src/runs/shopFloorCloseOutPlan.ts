/**
 * Deciding which workorders a daily close-out finishes.
 *
 * `populate:shop-floor` only places work on *free* positions, and the work it
 * places is left running. Run it again the next morning and every position is
 * still held by yesterday's job, so the floor loads nothing. The close-out is
 * the night shift: it finishes whatever is still holding a position from before
 * today, which frees the position for the morning load and turns yesterday's
 * floor into completed, invoiced history.
 *
 * Pure, and typed against structural subsets of the generated models, so the
 * rule that decides what gets closed is unit-tested without a backend.
 */
import type { BoardView } from './shopFloorRoster';

/** The fields of `WorkorderDetailResponse` this decision reads. */
export interface WorkorderView {
  status: string;
  createdAt: Date;
}

/** Statuses a workorder can be finished from. Anything else is left alone and reported. */
export const CLOSABLE_STATUSES: ReadonlySet<string> = new Set([
  'APPROVED',
  'ASSIGNED',
  'WORK_IN_PROGRESS',
  'AWAITING_PARTS',
  'AWAITING_APPROVAL',
  'READY_FOR_PICKUP',
]);

export interface HeldPosition {
  kind: 'BAY' | 'MOBILE_UNIT';
  id: string;
  name: string;
  workorderId: string;
}

export type CloseDecision =
  | { action: 'close'; position: HeldPosition }
  | { action: 'keep'; position: HeldPosition; reason: string };

/** Start of the UTC day containing `now`: the close-out finishes work created before it. */
export const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Every position on one site's dispatch board that an open workorder is holding. */
export const heldPositions = (board: BoardView): HeldPosition[] => [
  ...(board.bays ?? [])
    .filter((bay) => bay.assignedWorkorderId)
    .map((bay) => ({
      kind: 'BAY' as const,
      id: bay.bayId,
      name: bay.bayName ?? bay.bayId,
      workorderId: bay.assignedWorkorderId as string,
    })),
  ...(board.mobileUnits ?? [])
    .filter((unit) => unit.assignedWorkorderId)
    .map((unit) => ({
      kind: 'MOBILE_UNIT' as const,
      id: unit.unitId,
      name: unit.unitName ?? unit.unitId,
      workorderId: unit.assignedWorkorderId as string,
    })),
];

/**
 * Close a held position's workorder when it was created before today and sits
 * in a status it can be finished from. Today's work is the morning load's and
 * stays on the floor; a workorder the board names but whose detail could not be
 * read (`undefined`) is kept, because closing something unseen is not a risk a
 * populate run should take.
 */
export const decideCloseOut = (
  position: HeldPosition,
  workorder: WorkorderView | undefined,
  now: Date,
): CloseDecision => {
  if (workorder === undefined) {
    return { action: 'keep', position, reason: 'workorder detail unavailable' };
  }
  if (workorder.createdAt.getTime() >= startOfUtcDay(now).getTime()) {
    return { action: 'keep', position, reason: 'created today' };
  }
  const status = String(workorder.status).toUpperCase();
  if (!CLOSABLE_STATUSES.has(status)) {
    return { action: 'keep', position, reason: `status ${status} cannot be finished` };
  }
  return { action: 'close', position };
};
