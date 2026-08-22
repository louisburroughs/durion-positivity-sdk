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
    return this.readTime(await fetch(this.timeUrl));
  }

  /**
   * Returns the current virtual time as a Date.
   */
  async getCurrentVirtualTime(): Promise<Date> {
    return this.toDate(await this.fetchTime());
  }

  /**
   * The current virtual time, or null when the backend does not expose
   * /system/time at all - the normal, non-accelerated deployment. Every other
   * failure (unreachable backend, 5xx, unparseable body) still throws: only the
   * endpoint being absent is an expected answer rather than a fault.
   */
  async tryGetCurrentVirtualTime(): Promise<Date | null> {
    const res = await fetch(this.timeUrl);
    if (res.status === 404) {
      return null;
    }
    return this.toDate(await this.readTime(res));
  }

  private async readTime(res: Response): Promise<ServerTimeResponse> {
    if (!res.ok) {
      throw new Error(`Failed to fetch virtual time: HTTP ${res.status} ${res.statusText}`);
    }
    const data: ServerTimeResponse = await res.json();
    this.lastResponse = data;
    return data;
  }

  private toDate(resp: ServerTimeResponse): Date {
    const parsed = new Date(resp.virtualTime);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `Backend /system/time returned an unparseable virtualTime: ${JSON.stringify(resp.virtualTime)}`,
      );
    }
    return parsed;
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
