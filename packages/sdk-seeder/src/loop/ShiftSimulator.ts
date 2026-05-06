import { createPeopleClient } from '@durion-sdk/people';
import { SeederAuth } from '../SeederAuth';
import { SeederConfig } from '../SeederConfig';
import { ReferenceCache } from '../support/ReferenceCache';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const shuffle = <T>(values: T[]): T[] => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
};

export class ShiftSimulator {
  private readonly peopleClient;
  private activePersonIds: string[] = [];

  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
    private readonly refs: ReferenceCache,
  ) {
    this.peopleClient = createPeopleClient(this.auth.buildSdkConfig('people'));
  }

  async clockIn(): Promise<void> {
    const everyone = Array.from(
      new Set([
        ...this.refs.employees.technicians,
        ...this.refs.employees.serviceWriters,
        this.refs.employees.manager,
        this.refs.employees.partsClerk,
      ]),
    );

    if (everyone.length === 0) {
      console.log('[Shift] No employees available to clock in.');
      return;
    }

    const maxEmployees = Math.min(7, everyone.length);
    const minEmployees = Math.min(5, maxEmployees);
    const count = minEmployees === maxEmployees
      ? maxEmployees
      : minEmployees + Math.floor(Math.random() * (maxEmployees - minEmployees + 1));
    const selected = shuffle(everyone).slice(0, count);

    this.activePersonIds = [];

    for (const personId of selected) {
      try {
        const response = await this.peopleClient.workSessionsAPIApi.startWorkSession({
          workSessionRequest: { personId },
        });
        this.activePersonIds.push(personId);
        console.log(`[Shift] Clocked in ${personId} (${response.sessionId ?? 'session-opened'}).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[Shift] Clock-in failed for ${personId}: ${message}`);
      }

      await sleep(1000 + Math.floor(Math.random() * 1001));
    }
  }

  async clockOut(): Promise<void> {
    for (const personId of this.activePersonIds) {
      try {
        await this.peopleClient.workSessionsAPIApi.stopWorkSession({
          workSessionRequest: { personId },
        });
        console.log(`[Shift] Clocked out ${personId}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[Shift] Clock-out failed for ${personId}: ${message}`);
      }
    }

    this.activePersonIds = [];
  }

  async approveTimeEntries(): Promise<void> {
    try {
      await this.peopleClient.timeEntryApprovalAPIApi.approveTimeEntries({
        timeEntryDecisionBatchRequest: { decisions: [] },
      });
      console.log('[Shift] Submitted empty time-entry approval batch.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Shift] Time-entry approval failed: ${message}`);
    }
  }
}
