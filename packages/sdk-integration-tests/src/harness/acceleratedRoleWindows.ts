import type { ItestConfig } from './ItestConfig';

/**
 * Back-dates the credentialed personas' role windows so they cover the
 * accelerated run's virtual year.
 *
 * pos-security-service counts a role assignment only while
 * `effectiveStartDate <= asOf`, and `asOf` is the injected clock. The personas
 * were granted their roles in wall time, so on a backend anchored a year back
 * every one of those assignments starts in the future: the account logs in with
 * valid credentials and is refused 403 USER_HAS_NO_ROLES until virtual time
 * catches up with the day the role was granted.
 *
 * The existing assignment is never edited. For each role a persona holds from
 * the run's floor onward, a bridging assignment is added that starts at the
 * floor and ends exactly where the earliest live assignment of that role
 * begins. The backend refuses overlapping assignments of one role, and the two
 * windows only touch, so the bridge is accepted and the role is held without a
 * gap from the floor through to the original grant and beyond. A role already
 * held at the floor is left alone, which is what makes a re-run a no-op.
 *
 * Runs before starter activation, because activation logs every persona in and
 * is where the refusal surfaces first.
 */

/** Slack below virtualStart, so a zone offset in the backend's LocalDateTimes cannot leave the first hours uncovered. */
const FLOOR_MARGIN_MS = 86_400_000;

/**
 * One role assignment as the backend stores it. `start` and `end` are the
 * backend's LocalDateTime values read as UTC, so they compare with each other
 * and with the virtual anchors on one scale.
 */
export interface AssignmentWindow {
  roleId: string;
  roleCode: string;
  start: Date;
  end: Date | null;
}

export interface RoleBridge {
  roleId: string;
  roleCode: string;
  start: Date;
  end: Date;
}

export interface RoleWindowPort {
  listUsers(): Promise<Array<{ id: string; username: string }>>;
  /** Every assignment the user has ever held, expired, revoked and not-yet-started included. */
  listAssignments(userId: string): Promise<AssignmentWindow[]>;
  createAssignment(userId: string, bridge: RoleBridge): Promise<void>;
}

/**
 * The bridges one user needs so every role they hold from `virtualStart` onward
 * is already effective at `virtualStart`. Pure: no clock, no I/O.
 */
export function planRoleBridges(assignments: AssignmentWindow[], virtualStart: Date): RoleBridge[] {
  const anchor = virtualStart.getTime();
  const byRole = new Map<string, AssignmentWindow[]>();
  for (const assignment of assignments) {
    const group = byRole.get(assignment.roleId) ?? [];
    group.push(assignment);
    byRole.set(assignment.roleId, group);
  }

  const bridges: RoleBridge[] = [];
  for (const [roleId, group] of byRole) {
    // Live: still effective at, or starting after, the anchor. Everything else
    // ended at or before it and only constrains where a bridge may begin.
    const live = group.filter((a) => a.end === null || a.end.getTime() > anchor);
    if (live.length === 0) {
      // Revoked or expired before the run begins: not a role this persona holds.
      continue;
    }
    const earliest = live.reduce((min, a) => (a.start.getTime() < min.start.getTime() ? a : min));
    if (earliest.start.getTime() <= anchor) {
      continue;
    }
    const endedBefore = group
      .filter((a) => a.end !== null && a.end.getTime() <= anchor)
      .map((a) => (a.end as Date).getTime());
    const start = Math.max(anchor - FLOOR_MARGIN_MS, ...endedBefore);
    bridges.push({ roleId, roleCode: earliest.roleCode, start: new Date(start), end: earliest.start });
  }
  return bridges;
}

export class AcceleratedRoleWindows {
  constructor(
    private readonly config: ItestConfig,
    private readonly port: RoleWindowPort,
  ) {}

  /** Returns one line per bridge written, for the run log. */
  async run(virtualStart: Date): Promise<{ bridged: string[] }> {
    const ids = new Map((await this.port.listUsers()).map((user) => [user.username, user.id]));
    const bridged: string[] = [];
    for (const { credentials } of this.config.distinctAccounts()) {
      const userId = ids.get(credentials.username);
      if (userId === undefined) {
        // Not this step's to report: starter activation and the persona
        // preflight both name a missing account, with more context.
        continue;
      }
      for (const bridge of planRoleBridges(await this.port.listAssignments(userId), virtualStart)) {
        await this.port.createAssignment(userId, bridge);
        bridged.push(
          `${credentials.username} ${bridge.roleCode} from ${bridge.start.toISOString()} to ${bridge.end.toISOString()}`,
        );
      }
    }
    return { bridged };
  }
}

/**
 * Parses a backend LocalDateTime as UTC. The generated model runs it through
 * `new Date(...)`, which reads a zoneless value in the process's local zone, so
 * the listing is read raw instead.
 */
export function parseLocalDateTime(value: string): Date {
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(zoned);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`unreadable role-assignment timestamp "${value}"`);
  }
  return parsed;
}

/**
 * The inverse of parseLocalDateTime: UTC digits, no zone designator. Millisecond
 * precision, so a bridge ending on a microsecond-precise start ends a fraction of
 * a millisecond short of it — on the safe side of the overlap rule.
 */
export function formatLocalDateTime(value: Date): string {
  return value.toISOString().slice(0, -1);
}

interface RawAssignment {
  roleId: string;
  roleCode: string;
  effectiveStartDate: string;
  effectiveEndDate?: string | null;
}

/**
 * Talks to the security service directly with header auth, the path
 * SecurityBootstrap takes, rather than through an admin login: this runs before
 * starter activation, so the admin account may not be able to log in yet.
 */
export function createRoleWindowPort(config: ItestConfig): RoleWindowPort {
  const baseUrl = config.securityServiceUrl;
  const headers = (authority: string): Record<string, string> => ({
    'X-Authorities': authority,
    'X-User': 'itest-accel-role-windows',
    'X-Tenant-Id': config.tenant.id,
    'Content-Type': 'application/json',
  });
  const call = async (url: string, authority: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetch(url, { ...init, headers: headers(authority) });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`${init.method ?? 'GET'} ${url} answered ${response.status}${body ? ` - ${body}` : ''}`);
    }
    return response;
  };

  return {
    async listUsers() {
      const users = (await (await call(`${baseUrl}/v1/users`, 'security:user:view')).json()) as Array<{
        id: string;
        username: string;
      }>;
      return users.map(({ id, username }) => ({ id, username }));
    },
    async listAssignments(userId: string): Promise<AssignmentWindow[]> {
      // Raw JSON, not the generated model: its FromJSON runs these zoneless
      // values through new Date(...), which reads them in the process's zone.
      const url = `${baseUrl}/v1/roles/assignments/user/${encodeURIComponent(userId)}?includeHistory=true`;
      const rows = (await (await call(url, 'security:role:view')).json()) as RawAssignment[];
      return rows.map((row) => ({
        roleId: row.roleId,
        roleCode: row.roleCode,
        start: parseLocalDateTime(row.effectiveStartDate),
        end: row.effectiveEndDate ? parseLocalDateTime(row.effectiveEndDate) : null,
      }));
    },
    async createAssignment(userId: string, bridge: RoleBridge): Promise<void> {
      // Zoneless, the form the backend lists: the field is a LocalDateTime, and
      // nothing should rest on how its binder treats a zone designator.
      await call(`${baseUrl}/v1/roles/assignments`, 'security:role:assign', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          roleId: bridge.roleId,
          effectiveStartDate: formatLocalDateTime(bridge.start),
          effectiveEndDate: formatLocalDateTime(bridge.end),
        }),
      });
    },
  };
}
