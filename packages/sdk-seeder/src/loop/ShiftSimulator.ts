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

  private static readonly PERSON_NOT_FOUND_PREFIX = 'Person not found with id:';

  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
    private readonly refs: ReferenceCache,
  ) {
    this.peopleClient = createPeopleClient(this.auth.buildSdkConfig('people'));
  }

  /**
   * Close any open session for a person, silently swallowing 404 (no active session).
   * Called before each clock-in to ensure a clean slate even after a crashed prior run.
   */
  private async closeStaleSession(personId: string): Promise<void> {
    try {
      await this.peopleClient.workSessionsAPIApi.stopWorkSession({
        workSessionRequest: { personId },
      });
      console.log(`[Shift] Closed stale session for ${personId}.`);
    } catch (error) {
      const httpStatus = (error as { response?: { status?: number } }).response?.status;
      // 404 = no active session, which is the happy path; anything else is worth logging.
      if (httpStatus !== 404) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[Shift] Warning: could not close stale session for ${personId}: ${message}`);
      }
    }
  }

  private async formatHttpError(error: unknown): Promise<string> {
    const message = error instanceof Error ? error.message : String(error);
    const response = (error as { response?: Response }).response;
    if (!response) {
      return message;
    }

    let detail = '';
    try {
      const bodyText = await response.clone().text();
      const parsed = JSON.parse(bodyText) as { detail?: unknown; message?: unknown; error?: unknown };
      if (typeof parsed.detail === 'string') {
        detail = parsed.detail;
      } else if (typeof parsed.message === 'string') {
        detail = parsed.message;
      } else if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      // Keep message-only fallback when the body is not parseable JSON.
    }

    if (detail) {
      return `HTTP ${response.status} ${response.statusText} - ${detail}`;
    }
    return `HTTP ${response.status} ${response.statusText} - ${message}`;
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

    let personNotFoundCount = 0;

    for (const personId of selected) {
      // Ensure no stale session exists before starting a fresh one.
      await this.closeStaleSession(personId);

      try {
        const response = await this.peopleClient.workSessionsAPIApi.startWorkSession({
          workSessionRequest: { personId },
        });
        this.activePersonIds.push(personId);
        const employeeName = this.refs.employeeNameById.get(personId) ?? personId;
        console.log(`[Shift] Clocked in ${employeeName} (${personId}, ${response.sessionId ?? 'session-opened'}).`);
      } catch (error) {
        const message = await this.formatHttpError(error);
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status === 404 && message.includes(ShiftSimulator.PERSON_NOT_FOUND_PREFIX)) {
          personNotFoundCount += 1;
        }
        const employeeName = this.refs.employeeNameById.get(personId) ?? personId;
        console.log(`[Shift] Clock-in failed for ${employeeName} (${personId}): ${message}`);
      }

      await sleep(1000 + Math.floor(Math.random() * 1001));
    }

    if (this.activePersonIds.length === 0 && selected.length > 0 && personNotFoundCount === selected.length) {
      throw new Error(
        '[Shift] All selected employees failed clock-in with HTTP 404 "Person not found". ' +
          'Employee records exist but their person identities are missing in pos-people. ' +
          'Recreate or repair seeded employees in the backend before rerunning the seeder. ' +
          'If using docker-compose, verify POS_PEOPLE_KAFKA_ENABLED=true and POS_PEOPLE_CONTACT_KAFKA_ENABLED=true ' +
          'so people-contact replica sync is active.',
      );
    }
  }

  async clockOut(): Promise<void> {
    for (const personId of this.activePersonIds) {
      try {
        await this.peopleClient.workSessionsAPIApi.stopWorkSession({
          workSessionRequest: { personId },
        });
        const employeeName = this.refs.employeeNameById.get(personId) ?? personId;
        console.log(`[Shift] Clocked out ${employeeName}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const employeeName = this.refs.employeeNameById.get(personId) ?? personId;
        console.log(`[Shift] Clock-out failed for ${employeeName}: ${message}`);
      }
    }

    this.activePersonIds = [];
  }

  async approveTimeEntries(): Promise<void> {
    try {
      await this.peopleClient.timeEntryApprovalAPIApi.approveTimeEntriesBatch({
        timeEntryDecisionBatchRequest: { decisions: [] },
      });
      console.log('[Shift] Submitted empty time-entry approval batch.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Shift] Time-entry approval failed: ${message}`);
    }
  }
}
