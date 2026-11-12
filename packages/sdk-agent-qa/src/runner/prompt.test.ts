import { systemPrompt, weekdayName } from './prompt';

const context = { tenantSlug: 'alpha', date: '2026-03-11', time: '17:35', timeZone: 'America/New_York', runTag: 'qa-1', personas: ['manager', 'tech'], roleMode: false };

describe('systemPrompt', () => {
  it('tells the agent the day of the week, which some routines turn on', () => {
    expect(weekdayName('2026-03-11')).toBe('Wednesday');
    expect(weekdayName('2026-03-15')).toBe('Sunday');
    expect(systemPrompt({ persona: 'manager', kind: 'operations' }, context)).toContain('Today is Wednesday 2026-03-11, 17:35 shop time');
  });

  it('says so when the task is to provoke errors, and offers other personas only when they have their own logins', () => {
    expect(systemPrompt({ persona: 'advisor', kind: 'error' }, context)).toMatch(/deliberately provokes errors/);
    expect(systemPrompt({ persona: 'advisor', kind: 'operations' }, context)).not.toMatch(/accepts a "persona"/);
    expect(systemPrompt({ persona: 'advisor', kind: 'operations' }, { ...context, roleMode: true })).toMatch(/accepts a "persona"/);
  });
});
