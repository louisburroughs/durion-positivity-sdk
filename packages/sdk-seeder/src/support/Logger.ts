export type SeederPhase =
  | 'STARTUP'
  | 'BOOTSTRAP'
  | 'SHIFT-IN'
  | 'CUSTOMER'
  | 'SHIFT-OUT'
  | 'MAINTENANCE'
  | 'COMPLETE'
  | 'WAIT';

interface LogContext {
  day?: number;
  totalDays?: number;
  phase?: SeederPhase;
}

/**
 * Logger that prefixes every line with virtual time (from backend), real time (host),
 * day progress, and phase for full verifiability of the accelerated clock.
 */
export class Logger {
  private virtualTime: Date = new Date(0);
  private day: number = 0;
  private totalDays: number = 0;
  private phase: SeederPhase = 'STARTUP';
  private scale: number = 0;

  private formatPrefix(): string {
    const vt = this.virtualTime.toISOString();
    const rt = new Date().toISOString();
    const dayStr = this.day > 0 ? ` | Day ${this.day}/${this.totalDays}` : '';
    const scaleStr = this.scale > 0 ? ` @${this.scale}x` : '';
    return `[VT:${vt} | RT:${rt}${dayStr}${scaleStr} | ${this.phase}]`;
  }

  /** Update the cached virtual time (call after each fetch from backend) */
  setVirtualTime(vt: Date): void {
    this.virtualTime = vt;
  }

  /** Update the backend scale for display */
  setScale(scale: number): void {
    this.scale = scale;
  }

  /** Update day progress context */
  setDay(day: number, totalDays: number): void {
    this.day = day;
    this.totalDays = totalDays;
  }

  /** Update current phase */
  setPhase(phase: SeederPhase): void {
    this.phase = phase;
  }

  /** Log an info message with full timing context */
  info(...args: unknown[]): void {
    console.log(this.formatPrefix(), ...args);
  }

  /** Log an error message with full timing context */
  error(...args: unknown[]): void {
    console.error(this.formatPrefix(), ...args);
  }

  /** Log a separator line for readability between days */
  daySeparator(): void {
    console.log('─'.repeat(100));
  }
}
