import { ItestConfig } from './ItestConfig';
import {
  PersonaBootstrap,
  REQUIRED_AUTHORITIES,
  type LinkOutcome,
  type PersonaPeoplePort,
  type PersonaSecurityPort,
  type UserSummary,
} from './PersonaBootstrap';

const BASE_ENV = {
  ITEST_USERNAME: 'admin.alpha',
  ITEST_PASSWORD: 'admin-pw',
};

const ROLE_ENV = {
  ...BASE_ENV,
  ITEST_PARTS_USERNAME: 'gloria.mendez',
  ITEST_PARTS_PASSWORD: 'parts-pw',
};

/** Every authority the parts persona is checked for, so a user "passes". */
const PARTS_AUTHORITIES = [...REQUIRED_AUTHORITIES.parts];

interface SecurityCalls {
  getRoleIdByName: string[];
  assignUserRole: Array<{ userId: string; roleId: string }>;
  /** Usernames the preflight logged in as to read enforced authorities. */
  getEnforcedAuthorities: string[];
}

function fakeSecurity(
  users: UserSummary[],
  options: {
    permissions?: Record<string, string[]>;
    roleIds?: Record<string, string>;
    failRoleLookup?: boolean;
    failPermissions?: boolean;
  } = {},
): PersonaSecurityPort & { calls: SecurityCalls } {
  const calls: SecurityCalls = { getRoleIdByName: [], assignUserRole: [], getEnforcedAuthorities: [] };
  return {
    calls,
    listUsers: () => Promise.resolve(users),
    getEnforcedAuthorities: (credentials) => {
      calls.getEnforcedAuthorities.push(credentials.username);
      if (options.failPermissions) {
        return Promise.reject(new Error('403 Forbidden'));
      }
      // Keyed by username: the preflight now asks with credentials, because
      // what the gateway enforces lives in the persona's own token.
      return Promise.resolve(options.permissions?.[credentials.username] ?? []);
    },
    getRoleIdByName: (name) => {
      calls.getRoleIdByName.push(name);
      if (options.failRoleLookup) {
        return Promise.reject(new Error('404 role not found'));
      }
      return Promise.resolve(options.roleIds?.[name] ?? `role-${name}`);
    },
    assignUserRole: (userId, roleId) => {
      calls.assignUserRole.push({ userId, roleId });
      return Promise.resolve();
    },
  };
}

function fakePeople(
  outcomes: Record<string, LinkOutcome | Error> = {},
): PersonaPeoplePort & { calls: Array<{ username: string; personId: string }> } {
  const calls: Array<{ username: string; personId: string }> = [];
  return {
    calls,
    linkUserToPerson: (username, personId) => {
      calls.push({ username, personId });
      const outcome = outcomes[username] ?? 'created';
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

const EMPLOYEES = {
  technicians: ['person-tech-1', 'person-tech-2'],
  serviceWriters: ['person-writer-1'],
  manager: 'person-manager',
  partsClerk: 'person-parts',
};

describe('PersonaBootstrap: applies only in role mode', () => {
  it('does not apply when no persona credentials are configured', () => {
    const config = ItestConfig.fromEnv(BASE_ENV);
    const bootstrap = new PersonaBootstrap(config, fakeSecurity([]), fakePeople());
    expect(bootstrap.applies).toBe(false);
  });

  it('applies as soon as one persona is configured', () => {
    const config = ItestConfig.fromEnv(ROLE_ENV);
    const bootstrap = new PersonaBootstrap(config, fakeSecurity([]), fakePeople());
    expect(bootstrap.applies).toBe(true);
  });
});

describe('PersonaBootstrap.verifyAndProvision', () => {
  it('verifies a persona that already holds its role and authorities', async () => {
    const security = fakeSecurity(
      [{ id: 'u-1', username: 'gloria.mendez', roles: ['INVENTORY_LEAD'] }],
      { permissions: { 'gloria.mendez': PARTS_AUTHORITIES } },
    );
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), security, fakePeople());

    const result = await bootstrap.verifyAndProvision();

    expect(result.verified).toEqual(['parts=gloria.mendez']);
    // Already holds the role: nothing is granted, and the role lookup is not
    // even attempted.
    expect(result.assignments).toEqual([]);
    expect(security.calls.assignUserRole).toEqual([]);
    expect(security.calls.getRoleIdByName).toEqual([]);
  });

  it('grants INVENTORY_LEAD when the parts account lacks it', async () => {
    const security = fakeSecurity([{ id: 'u-1', username: 'gloria.mendez', roles: [] }], {
      permissions: { 'gloria.mendez': PARTS_AUTHORITIES },
      roleIds: { INVENTORY_LEAD: 'role-uuid-77' },
    });
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), security, fakePeople());

    const result = await bootstrap.verifyAndProvision();

    expect(security.calls.getRoleIdByName).toEqual(['INVENTORY_LEAD']);
    // Resolved by name, never a hardcoded UUID, and assigned additively by id.
    expect(security.calls.assignUserRole).toEqual([{ userId: 'u-1', roleId: 'role-uuid-77' }]);
    expect(result.assignments).toEqual(['gloria.mendez granted INVENTORY_LEAD']);
    expect(result.verified).toEqual(['parts=gloria.mendez']);
  });

  it('fails with the username when no such user exists', async () => {
    const security = fakeSecurity([{ id: 'u-9', username: 'someone.else', roles: [] }]);
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), security, fakePeople());

    await expect(bootstrap.verifyAndProvision()).rejects.toThrow(
      /parts: no user named "gloria.mendez" exists/,
    );
  });

  it('names every missing authority rather than the first', async () => {
    const security = fakeSecurity(
      [{ id: 'u-1', username: 'gloria.mendez', roles: ['INVENTORY_LEAD'] }],
      { permissions: { 'gloria.mendez': ['order:purchase_order:create'] } },
    );
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), security, fakePeople());

    const error = await bootstrap.verifyAndProvision().catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('inventory:asn:create');
    expect((error as Error).message).toContain('inventory:goods_receipt:create');
    expect((error as Error).message).toContain('inventory:receiving:create');
    // And says what it does hold, so the fix is obvious.
    expect((error as Error).message).toContain('holds: INVENTORY_LEAD');
  });

  it('collects problems across personas into one error', async () => {
    const env = {
      ...ROLE_ENV,
      ITEST_TECH_USERNAME: 'kyle.brennan',
      ITEST_TECH_PASSWORD: 'tech-pw',
    };
    const security = fakeSecurity(
      [{ id: 'u-2', username: 'kyle.brennan', roles: ['TECHNICIAN'] }],
      { permissions: { 'kyle.brennan': [] } },
    );
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(env), security, fakePeople());

    const error = await bootstrap.verifyAndProvision().catch((e: Error) => e);

    const message = (error as Error).message;
    expect(message).toContain('no user named "gloria.mendez"');
    expect(message).toContain('workorder:start');
    expect(message).toContain('BACKEND_INTERACTION_TEST_SPEC.md');
  });

  it('reports a failed grant as a preflight problem, not a crash', async () => {
    const security = fakeSecurity([{ id: 'u-1', username: 'gloria.mendez', roles: [] }], {
      failRoleLookup: true,
    });
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), security, fakePeople());

    await expect(bootstrap.verifyAndProvision()).rejects.toThrow(
      /lacks INVENTORY_LEAD and it could not be granted \(404 role not found\)/,
    );
    // The permission read is skipped once the grant failed - no cascade.
    expect(security.calls.getEnforcedAuthorities).toEqual([]);
  });

  it('surfaces the HTTP status a generated ResponseError hides', async () => {
    // The generated clients always say "Response returned an error code"; the
    // status lives on .response, and without it the operator cannot tell a
    // missing permission from a missing role.
    const responseError = Object.assign(new Error('Response returned an error code'), {
      response: { status: 403, url: 'http://gw/security-service/v1/users/u-1/permissions' },
    });
    const security: PersonaSecurityPort = {
      listUsers: () =>
        Promise.resolve([{ id: 'u-1', username: 'gloria.mendez', roles: ['INVENTORY_LEAD'] }]),
      getEnforcedAuthorities: () => Promise.reject(responseError),
      getRoleIdByName: () => Promise.resolve('role-1'),
      assignUserRole: () => Promise.resolve(),
    };
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), security, fakePeople());

    const error = await bootstrap.verifyAndProvision().catch((e: Error) => e);

    expect((error as Error).message).toContain('HTTP 403');
    expect((error as Error).message).toContain('/v1/users/u-1/permissions');
  });

  it('reports an unreadable permission set against the persona', async () => {
    const security = fakeSecurity(
      [{ id: 'u-1', username: 'gloria.mendez', roles: ['INVENTORY_LEAD'] }],
      { failPermissions: true },
    );
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), security, fakePeople());

    await expect(bootstrap.verifyAndProvision()).rejects.toThrow(
      /parts: could not establish what "gloria.mendez" is authorized for \(403 Forbidden\)/,
    );
  });
});

describe('PersonaBootstrap.linkPersons', () => {
  it('links a persona to its matching seeded employee', async () => {
    const people = fakePeople();
    const bootstrap = new PersonaBootstrap(
      ItestConfig.fromEnv(ROLE_ENV),
      fakeSecurity([]),
      people,
    );

    const result = await bootstrap.linkPersons(EMPLOYEES);

    expect(people.calls).toEqual([{ username: 'gloria.mendez', personId: 'person-parts' }]);
    expect(result.links).toEqual(['gloria.mendez -> person person-parts']);
    expect(result.limitations).toEqual([]);
  });

  it('maps each persona to the right employee bucket', async () => {
    const env = {
      ...ROLE_ENV,
      ITEST_TECH_USERNAME: 'kyle.brennan',
      ITEST_TECH_PASSWORD: 'tech-pw',
      ITEST_ADVISOR_USERNAME: 'rachel.kim',
      ITEST_ADVISOR_PASSWORD: 'advisor-pw',
      ITEST_MANAGER_USERNAME: 'diana.rowe',
      ITEST_MANAGER_PASSWORD: 'manager-pw',
    };
    const people = fakePeople();
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(env), fakeSecurity([]), people);

    await bootstrap.linkPersons(EMPLOYEES);

    expect(people.calls).toEqual(
      expect.arrayContaining([
        { username: 'rachel.kim', personId: 'person-writer-1' },
        { username: 'kyle.brennan', personId: 'person-tech-1' },
        { username: 'diana.rowe', personId: 'person-manager' },
        { username: 'gloria.mendez', personId: 'person-parts' },
      ]),
    );
  });

  it('records a persona with no seeded employee as a limitation', async () => {
    const env = { ...BASE_ENV, ITEST_ACCT_USERNAME: 'irene.torres', ITEST_ACCT_PASSWORD: 'acct-pw' };
    const people = fakePeople();
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(env), fakeSecurity([]), people);

    const result = await bootstrap.linkPersons(EMPLOYEES);

    expect(people.calls).toEqual([]);
    expect(result.limitations).toEqual([
      'acct (irene.torres) has no seeded employee to link to, so labor attributed to it has no person record',
    ]);
  });

  it('treats a username already linked elsewhere as a limitation, not a failure', async () => {
    const people = fakePeople({ 'gloria.mendez': 'linked-elsewhere' });
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), fakeSecurity([]), people);

    const result = await bootstrap.linkPersons(EMPLOYEES);

    expect(result.links).toEqual([]);
    expect(result.limitations[0]).toContain('already linked to a different person');
  });

  it('survives a linking error and reports it', async () => {
    const people = fakePeople({ 'gloria.mendez': new Error('500 Internal Server Error') });
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), fakeSecurity([]), people);

    const result = await bootstrap.linkPersons(EMPLOYEES);

    expect(result.limitations[0]).toContain('500 Internal Server Error');
  });

  it('reports an empty employee bucket rather than linking to undefined', async () => {
    const people = fakePeople();
    const bootstrap = new PersonaBootstrap(ItestConfig.fromEnv(ROLE_ENV), fakeSecurity([]), people);

    const result = await bootstrap.linkPersons({ ...EMPLOYEES, partsClerk: '' });

    expect(people.calls).toEqual([]);
    expect(result.limitations[0]).toContain('produced no employee to link');
  });
});
