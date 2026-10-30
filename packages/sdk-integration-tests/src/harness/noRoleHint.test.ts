import { noRoleHint } from './noRoleHint';

describe('noRoleHint', () => {
  it('explains a login refused with USER_HAS_NO_ROLES', () => {
    expect(noRoleHint('[403 http://gw/v1/auth/login - {"code":"USER_HAS_NO_ROLES"}]')).toContain(
      'an administrator must assign one',
    );
  });

  it('adds nothing to any other failure', () => {
    expect(noRoleHint('[401 http://gw/v1/auth/login - INVALID_CREDENTIALS]')).toBe('');
  });
});
