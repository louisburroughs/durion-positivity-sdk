/**
 * A login refused for want of a role is not something setup can repair: the
 * suite admin's role comes from the backend seed, not from the harness.
 */
export function noRoleHint(failure: string): string {
  return failure.includes('USER_HAS_NO_ROLES')
    ? ' - the account holds no role in this tenant; an administrator must assign one ' +
        '(alpha seeds admin.alpha with full_access via Flyway), the harness no longer grants roles'
    : '';
}
