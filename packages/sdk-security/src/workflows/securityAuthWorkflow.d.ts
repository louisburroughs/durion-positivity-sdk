import { AuthAPIApi } from '../apis/AuthAPIApi';
import { JWTAPIApi } from '../apis/JWTAPIApi';
export declare class SecurityAuthWorkflow {
    private readonly authApi;
    private readonly jwtApi;
    constructor(authApi: AuthAPIApi, jwtApi: JWTAPIApi);
    /** @operationId login */
    login(params: Parameters<AuthAPIApi['login']>[0]): Promise<import("..").TokenPairResponse>;
    /** @operationId refreshAccessToken */
    refresh(params: Parameters<JWTAPIApi['refreshAccessToken']>[0]): Promise<import("..").TokenPairResponse>;
    /** @operationId validateToken */
    validate(params: Parameters<JWTAPIApi['validateToken']>[0]): Promise<import("..").ValidateResponse>;
    /** @operationId revokeToken */
    revoke(params: Parameters<JWTAPIApi['revokeToken']>[0]): Promise<void>;
}
