import { AuthAPIApi } from '../apis/AuthAPIApi';
import { JWTAPIApi } from '../apis/JWTAPIApi';

export class SecurityAuthWorkflow {
  constructor(
    private readonly authApi: AuthAPIApi,
    private readonly jwtApi: JWTAPIApi,
  ) { }

  /** @operationId loginUser */
  login(params: Parameters<AuthAPIApi['loginUser']>[0]) {
    return this.authApi.loginUser(params);
  }

  /** @operationId refreshTokenPair */
  refresh(params: Parameters<JWTAPIApi['refreshTokenPair']>[0]) {
    return this.jwtApi.refreshTokenPair(params);
  }

  /** @operationId validateToken */
  validate(params: Parameters<JWTAPIApi['validateToken']>[0]) {
    return this.jwtApi.validateToken(params);
  }

  /** @operationId revokeToken */
  revoke(params: Parameters<JWTAPIApi['revokeToken']>[0]) {
    return this.jwtApi.revokeToken(params);
  }
}
