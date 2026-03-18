import { AuthAPIApi } from '../apis/AuthAPIApi';
import { JWTAPIApi } from '../apis/JWTAPIApi';

export class SecurityAuthWorkflow {
  constructor(
    private readonly authApi: AuthAPIApi,
    private readonly jwtApi: JWTAPIApi,
  ) {}

  /** @operationId login */
  login(params: Parameters<AuthAPIApi['login']>[0]) {
    return this.authApi.login(params);
  }

  /** @operationId refreshAccessToken */
  refresh(params: Parameters<JWTAPIApi['refreshAccessToken']>[0]) {
    return this.jwtApi.refreshAccessToken(params);
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
