"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityAuthWorkflow = void 0;
class SecurityAuthWorkflow {
    constructor(authApi, jwtApi) {
        this.authApi = authApi;
        this.jwtApi = jwtApi;
    }
    /** @operationId login */
    login(params) {
        return this.authApi.login(params);
    }
    /** @operationId refreshAccessToken */
    refresh(params) {
        return this.jwtApi.refreshAccessToken(params);
    }
    /** @operationId validateToken */
    validate(params) {
        return this.jwtApi.validateToken(params);
    }
    /** @operationId revokeToken */
    revoke(params) {
        return this.jwtApi.revokeToken(params);
    }
}
exports.SecurityAuthWorkflow = SecurityAuthWorkflow;
