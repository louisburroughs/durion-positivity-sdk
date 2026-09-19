import { ItestConfig } from './ItestConfig';
import {
  AcceleratedRoleWindows,
  formatLocalDateTime,
  parseLocalDateTime,
  planRoleBridges,
  type AssignmentWindow,
  type RoleBridge,
  type RoleWindowPort,
} from './acceleratedRoleWindows';

const VIRTUAL_START = new Date('2025-09-18T21:26:58Z');
const FLOOR = new Date('2025-09-17T21:26:58Z');
const GRANTED = new Date('2026-09-14T11:49:28.591Z');

function window(roleId: string, start: string, end: string | null = null): AssignmentWindow {
  return { roleId, roleCode: roleId.toUpperCase(), start: new Date(start), end: end === null ? null : new Date(end) };
}

describe('planRoleBridges', () => {
  it('bridges a role granted after the anchor, from a day below it to the grant', () => {
    expect(planRoleBridges([window('tech', GRANTED.toISOString())], VIRTUAL_START)).toEqual([
      { roleId: 'tech', roleCode: 'TECH', start: FLOOR, end: GRANTED },
    ]);
  });

  it('leaves a role already in effect at the anchor alone, so a re-run writes nothing', () => {
    const bridged = [window('tech', FLOOR.toISOString(), GRANTED.toISOString()), window('tech', GRANTED.toISOString())];
    expect(planRoleBridges(bridged, VIRTUAL_START)).toEqual([]);
  });

  it('treats a start exactly at the anchor as in effect', () => {
    expect(planRoleBridges([window('tech', VIRTUAL_START.toISOString())], VIRTUAL_START)).toEqual([]);
  });

  it('ignores a role revoked before the anchor: the persona does not hold it', () => {
    expect(planRoleBridges([window('old', '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z')], VIRTUAL_START)).toEqual([]);
  });

  it('bridges to the earliest live assignment when a role was granted more than once', () => {
    const later = '2026-09-16T00:00:00Z';
    const [bridge] = planRoleBridges(
      [window('tech', later), window('tech', GRANTED.toISOString(), later)],
      VIRTUAL_START,
    );
    expect(bridge.end).toEqual(GRANTED);
  });

  it('starts the bridge after an earlier window that ends inside the margin, so the two cannot overlap', () => {
    const endedAt = '2025-09-18T00:00:00Z';
    const [bridge] = planRoleBridges(
      [window('tech', '2025-01-01T00:00:00Z', endedAt), window('tech', GRANTED.toISOString())],
      VIRTUAL_START,
    );
    expect(bridge.start).toEqual(new Date(endedAt));
  });

  it('plans each role on its own', () => {
    const bridges = planRoleBridges(
      [window('tech', GRANTED.toISOString()), window('lead', '2025-01-01T00:00:00Z')],
      VIRTUAL_START,
    );
    expect(bridges.map((b) => b.roleId)).toEqual(['tech']);
  });
});

describe('LocalDateTime round trip', () => {
  it('reads a zoneless value as UTC whatever the process zone', () => {
    expect(parseLocalDateTime('2026-09-14T11:49:28.591123')).toEqual(GRANTED);
  });

  it('keeps an explicit zone', () => {
    expect(parseLocalDateTime('2026-09-14T11:49:28.591Z')).toEqual(GRANTED);
  });

  it('refuses an unreadable value rather than planning around NaN', () => {
    expect(() => parseLocalDateTime('not-a-date')).toThrow('unreadable role-assignment timestamp');
  });

  it('writes the zoneless form back, truncated to the millisecond', () => {
    expect(formatLocalDateTime(parseLocalDateTime('2026-09-14T11:49:28.591123'))).toBe('2026-09-14T11:49:28.591');
  });
});

describe('AcceleratedRoleWindows', () => {
  const config = ItestConfig.fromEnv({
    ITEST_USERNAME: 'admin.alpha',
    ITEST_PASSWORD: 'admin-pw',
    ALPHA_TENANT_SLUG: 'alpha',
    ALPHA_TENANT_ID: '01900000-0000-7000-8000-000000000001',
    ITEST_TECH_USERNAME: 'kyle.brennan',
    ITEST_TECH_PASSWORD: 'tech-pw',
    ITEST_PARTS_USERNAME: 'gloria.mendez',
    ITEST_PARTS_PASSWORD: 'parts-pw',
  });

  function fakePort(assignments: Record<string, AssignmentWindow[]>): RoleWindowPort & {
    created: Array<{ userId: string; bridge: RoleBridge }>;
  } {
    const created: Array<{ userId: string; bridge: RoleBridge }> = [];
    return {
      created,
      listUsers: () =>
        Promise.resolve([
          { id: 'u-admin', username: 'admin.alpha' },
          { id: 'u-tech', username: 'kyle.brennan' },
          { id: 'u-parts', username: 'gloria.mendez' },
          { id: 'u-other', username: 'someone.else' },
        ]),
      listAssignments: (userId) => Promise.resolve(assignments[userId] ?? []),
      createAssignment: (userId, bridge) => {
        created.push({ userId, bridge });
        return Promise.resolve();
      },
    };
  }

  it('bridges only the configured accounts whose roles start after the anchor', async () => {
    const port = fakePort({
      'u-admin': [window('sysadmin', '2025-01-01T00:00:00Z')],
      'u-tech': [window('technician', GRANTED.toISOString())],
      'u-parts': [window('inventory_lead', GRANTED.toISOString())],
      'u-other': [window('technician', GRANTED.toISOString())],
    });

    const { bridged } = await new AcceleratedRoleWindows(config, port).run(VIRTUAL_START);

    expect(port.created.map((c) => c.userId)).toEqual(['u-tech', 'u-parts']);
    expect(bridged).toEqual([
      `kyle.brennan TECHNICIAN from ${FLOOR.toISOString()} to ${GRANTED.toISOString()}`,
      `gloria.mendez INVENTORY_LEAD from ${FLOOR.toISOString()} to ${GRANTED.toISOString()}`,
    ]);
  });

  it('skips a configured account the backend does not know, leaving it to activation to report', async () => {
    const port = fakePort({});
    port.listUsers = () => Promise.resolve([{ id: 'u-admin', username: 'admin.alpha' }]);

    await expect(new AcceleratedRoleWindows(config, port).run(VIRTUAL_START)).resolves.toEqual({ bridged: [] });
  });
});
