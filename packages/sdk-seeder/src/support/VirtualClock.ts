export interface ServerTimeResponse {
  virtualTime: string;
  scale: number;
  zone: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls the backend's /system/time endpoint to get the authoritative virtual time.
 * The seeder does NO time scaling itself — the backend is the single source of truth.
 */
export class VirtualClock {
  private readonly timeUrl: string;
  private readonly pollIntervalMs: number;
  private lastResponse: ServerTimeResponse | null = null;

  constructor(baseUrl: string, pollIntervalMs: number) {
    this.timeUrl = `${baseUrl}/system/time`;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Fetch the current virtual time from the backend.
   * Throws if the endpoint is unreachable.
   */
  async fetchTime(): Promise<ServerTimeResponse> {
    const res = await fetch(this.timeUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch virtual time: HTTP ${res.status} ${res.statusText}`);
    }
    const data: ServerTimeResponse = await res.json();
    this.lastResponse = data;
    return data;
  }

  /**
   * Returns the current virtual time as a Date.
   */
  async getCurrentVirtualTime(): Promise<Date> {
    const resp = await this.fetchTime();
    return new Date(resp.virtualTime);
  }

  /**
   * Returns the last fetched scale value (for logging).
   */
  getLastScale(): number {
    return this.lastResponse?.scale ?? 0;
  }

  /**
   * Waits until the backend's virtual time crosses midnight into the next calendar day
   * relative to the given currentDayStart.
   *
   * Returns the new virtual time once the day boundary is crossed.
   */
  async waitForNextDay(currentDayStart: Date): Promise<Date> {
    const nextDayMidnight = new Date(currentDayStart);
    nextDayMidnight.setUTCDate(nextDayMidnight.getUTCDate() + 1);
    nextDayMidnight.setUTCHours(0, 0, 0, 0);

    while (true) {
      await sleep(this.pollIntervalMs);
      const now = await this.getCurrentVirtualTime();
      if (now >= nextDayMidnight) {
        return now;
      }
    }
  }

  /**
   * Waits until the backend's /system/time endpoint becomes reachable.
   * Used during startup to wait for the backend to be fully ready.
   */
  async waitForBackend(timeoutMs: number = 120_000): Promise<ServerTimeResponse> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        return await this.fetchTime();
      } catch (err) {
        lastError = err;
        await sleep(2000);
      }
    }

    throw new Error(
      `Backend /system/time not reachable after ${timeoutMs}ms. Last error: ${lastError}`,
    );
  }
}
