import { AcceleratedConfig, assessFeasibility, MIN_STEPS_PER_WINDOW } from './acceleratedConfig';

describe('AcceleratedConfig.fromEnv', () => {
  it('defaults to a full-year, 6.5-hour-budget, Mon-Sat run', () => {
    const config = AcceleratedConfig.fromEnv({});

    expect(config.days).toBe(365);
    expect(config.runBudgetMs).toBe(23_400_000);
    expect(config.sampleEvery).toBe(1);
    expect(config.concurrency).toBe(8);
    expect(config.weekdayWindow).toEqual({ openMinutes: 480, closeMinutes: 1080 });
    expect(config.saturdayWindow).toEqual({ openMinutes: 540, closeMinutes: 780 });
    expect(config.sundayWindow).toBeNull();
    expect(config.mobileAfterHours).toBe(true);
    expect(config.publishCalendar).toBe(true);
    expect(config.graceMinutes).toBe(90);
    expect(config.unpaidRatio).toBe(0);
    expect(config.journalPath).toBe('.itest-accel-journal.json');
    // The lock travels with the journal unless it is named explicitly.
    expect(config.lockPath).toBe('.itest-accel-journal.json.lock');
    expect(config.lockUri).toBeUndefined();
  });

  it('reads the windows', () => {
    const config = AcceleratedConfig.fromEnv({
      ITEST_ACCEL_OPEN_TIME: '07:30',
      ITEST_ACCEL_CLOSE_TIME: '19:00',
      ITEST_ACCEL_SATURDAY: 'closed',
      ITEST_ACCEL_SUNDAY: '10:00-14:00',
    });

    expect(config.weekdayWindow).toEqual({ openMinutes: 450, closeMinutes: 1140 });
    expect(config.saturdayWindow).toBeNull();
    expect(config.sundayWindow).toEqual({ openMinutes: 600, closeMinutes: 840 });
  });

  it('refuses a weekday window that closes before it opens', () => {
    expect(() => AcceleratedConfig.fromEnv({ ITEST_ACCEL_OPEN_TIME: '18:00', ITEST_ACCEL_CLOSE_TIME: '08:00' })).toThrow(
      /ITEST_ACCEL_OPEN_TIME must be earlier than ITEST_ACCEL_CLOSE_TIME/,
    );
  });

  it('collects every problem into one error rather than failing a variable at a time', () => {
    const message = (() => {
      try {
        AcceleratedConfig.fromEnv({
          ITEST_ACCEL_DAYS: 'many',
          ITEST_ACCEL_CONCURRENCY: '0',
          ITEST_ACCEL_UNPAID_RATIO: '4',
          ITEST_ACCEL_HOLIDAYS: '2025-13-99,nope',
          ITEST_ACCEL_PUBLISH_CALENDAR: 'maybe',
        });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toMatch(/ITEST_ACCEL_DAYS must be an integer/);
    expect(message).toMatch(/ITEST_ACCEL_CONCURRENCY must be at least 1/);
    expect(message).toMatch(/ITEST_ACCEL_UNPAID_RATIO must be a number between 0 and 1/);
    expect(message).toMatch(/ITEST_ACCEL_HOLIDAYS must be comma-separated YYYY-MM-DD/);
    expect(message).toMatch(/ITEST_ACCEL_PUBLISH_CALENDAR must be true or false/);
  });

  it('refuses a jobs-per-day range that is inverted', () => {
    expect(() =>
      AcceleratedConfig.fromEnv({ ITEST_ACCEL_JOBS_PER_DAY_MIN: '10', ITEST_ACCEL_JOBS_PER_DAY_MAX: '2' }),
    ).toThrow(/MAX \(2\) must be at least ITEST_ACCEL_JOBS_PER_DAY_MIN \(10\)/);
  });

  it('refuses an inverted appointment lead range', () => {
    expect(() =>
      AcceleratedConfig.fromEnv({
        ITEST_ACCEL_APPOINTMENT_LEAD_DAYS_MIN: '9',
        ITEST_ACCEL_APPOINTMENT_LEAD_DAYS_MAX: '2',
      }),
    ).toThrow(/APPOINTMENT_LEAD_DAYS_MAX \(2\)/);
  });

  it('accepts an explicit holiday list and uses it instead of the federal set', () => {
    const config = AcceleratedConfig.fromEnv({ ITEST_ACCEL_HOLIDAYS: '2025-11-03, 2025-11-04' });
    const calendar = config.calendarFor(new Date('2025-09-17T00:00:00Z'), new Date('2026-09-17T00:00:00Z'));

    expect(calendar.isWorkingDay(new Date('2025-11-03T10:00:00Z'))).toBe(false);
    expect(calendar.isWorkingDay(new Date('2025-12-25T10:00:00Z'))).toBe(true);
  });

  it('defaults the holiday set to every calendar year the virtual span touches', () => {
    const calendar = AcceleratedConfig.fromEnv({}).calendarFor(
      new Date('2025-09-17T00:00:00Z'),
      new Date('2026-09-17T00:00:00Z'),
    );

    expect(calendar.isWorkingDay(new Date('2025-12-25T10:00:00Z'))).toBe(false);
    expect(calendar.isWorkingDay(new Date('2026-07-04T10:00:00Z'))).toBe(false);
  });

  it('derives the lock file from the journal, and takes an explicit one', () => {
    expect(AcceleratedConfig.fromEnv({ ITEST_ACCEL_JOURNAL: 'runs/year.json' }).lockPath).toBe('runs/year.json.lock');
    expect(
      AcceleratedConfig.fromEnv({ ITEST_ACCEL_JOURNAL: 'runs/year.json', ITEST_ACCEL_LOCK_FILE: '/tmp/alpha.lock' })
        .lockPath,
    ).toBe('/tmp/alpha.lock');
  });

  it('records the advisory lock URI without pretending to enforce it', () => {
    const config = AcceleratedConfig.fromEnv({ ITEST_ACCEL_LOCK_URI: 's3://durion-alpha-deploy/locks/accelerated.json' });
    expect(config.lockUri).toBe('s3://durion-alpha-deploy/locks/accelerated.json');
  });

  it('treats an empty string as unset, so a blank .env line does not fail the run', () => {
    const config = AcceleratedConfig.fromEnv({ ITEST_ACCEL_DAYS: '', ITEST_ACCEL_LOCK_URI: '' });
    expect(config.days).toBe(365);
    expect(config.lockUri).toBeUndefined();
  });
});

describe('assessFeasibility', () => {
  const latency = { stepLatencyMs: 1_000, jobLatencyMs: 20_000, steps: 22 };

  it('passes at the documented default: scale 1460, a 10h window, 8 in parallel', () => {
    const verdict = assessFeasibility({
      scale: 1460,
      shortestOpenMinutes: 600,
      graceMinutes: 90,
      latency,
      concurrency: 8,
      sampledOpenDays: 250,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.openRealSeconds).toBeCloseTo(24.7, 1);
    // A 20s lifecycle against a 24.7s window: one window is enough.
    expect(verdict.openWindowsPerJob).toBe(1);
    expect(verdict.jobsPerDay).toBe(8);
    expect(verdict.expectedWorkorders).toBe(2000);
    expect(verdict.minWorkorders).toBe(1200);
  });

  it('spreads a job across windows when the window is tighter than the lifecycle', () => {
    const verdict = assessFeasibility({
      scale: 8760,
      shortestOpenMinutes: 600,
      graceMinutes: 90,
      latency: { stepLatencyMs: 300, jobLatencyMs: 20_000, steps: 22 },
      concurrency: 8,
      sampledOpenDays: 250,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.openRealSeconds).toBeCloseTo(4.1, 1);
    expect(verdict.openWindowsPerJob).toBe(5);
    expect(verdict.jobsPerDay).toBe(1);
    expect(verdict.expectedWorkorders).toBe(250);
  });

  it('refuses a window too tight for even a couple of steps, and names a workable scale', () => {
    // A grace wide enough that the step-fits-the-grace check is not the binding one here:
    // this case is about the window, and at scale 26,280 a 1s call is 438 virtual minutes,
    // which the default 90-minute grace refuses first.
    const verdict = assessFeasibility({
      scale: 26_280,
      shortestOpenMinutes: 600,
      graceMinutes: 1_440,
      latency,
      concurrency: 8,
      sampledOpenDays: 250,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/an open window is 1\.4 real seconds at scale 26280/);
    expect(verdict.reason).toMatch(new RegExp(`fewer than the ${MIN_STEPS_PER_WINDOW} steps`));
    expect(verdict.suggestedScaleCeiling).toBe(18_000);
    expect(verdict.reason).toContain('scale=18000');
  });

  it('refuses when a job needs more windows than there are parallel slots', () => {
    const verdict = assessFeasibility({
      scale: 4380,
      shortestOpenMinutes: 240,
      graceMinutes: 90,
      latency: { stepLatencyMs: 500, jobLatencyMs: 60_000, steps: 22 },
      concurrency: 2,
      sampledOpenDays: 250,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.openWindowsPerJob).toBeGreaterThan(2);
    expect(verdict.reason).toMatch(/Raise ITEST_ACCEL_CONCURRENCY to at least \d+/);
  });

  it('refuses a run with too few worked days to assert anything', () => {
    const verdict = assessFeasibility({
      scale: 1460,
      shortestOpenMinutes: 600,
      graceMinutes: 90,
      latency,
      concurrency: 8,
      sampledOpenDays: 0,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/nothing to assert/);
  });

  it('refuses a scale at which one step does not fit inside the grace', () => {
    // The day's first step runs with nothing to predict from, so a step larger than the
    // grace pushes the shift end outside the window the payroll audit accepts — and no
    // bound on the rest of the day can help. A 1s call at scale 8,760 is 146 virtual
    // minutes against a 90-minute grace.
    const verdict = assessFeasibility({
      scale: 8760,
      shortestOpenMinutes: 600,
      graceMinutes: 90,
      latency: { stepLatencyMs: 1_000, jobLatencyMs: 20_000, steps: 22 },
      concurrency: 8,
      sampledOpenDays: 250,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/146 virtual minutes .* does not fit inside the 90-minute overrun grace/);
    // The ceiling named must itself pass the guard. 90 min / 1 s is exactly 5,400, and
    // at 5,400 a step is exactly 90 minutes, which the guard refuses — so the largest
    // scale that fits is 5,399. The first cut of this test codified 5,400.
    expect(verdict.suggestedScaleCeiling).toBe(5_399);
    expect(
      assessFeasibility({
        scale: verdict.suggestedScaleCeiling,
        shortestOpenMinutes: 600,
        graceMinutes: 90,
        latency: { stepLatencyMs: 1_000, jobLatencyMs: 20_000, steps: 22 },
        concurrency: 8,
        sampledOpenDays: 250,
      }).ok,
    ).toBe(true);
  });

  it('measures against the tightest window, so a Saturday half-day is what must fit', () => {
    const saturday = assessFeasibility({
      scale: 1460,
      shortestOpenMinutes: 240,
      graceMinutes: 90,
      latency,
      concurrency: 8,
      sampledOpenDays: 250,
    });

    expect(saturday.openRealSeconds).toBeCloseTo(9.9, 1);
    expect(saturday.openWindowsPerJob).toBe(3);
    expect(saturday.jobsPerDay).toBe(2);
  });
});
