"use strict";
/* tslint:disable */
/* eslint-disable */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DurionSdkError = void 0;
class DurionSdkError extends Error {
    response;
    error;
    constructor(response, error) {
        super(`DurionSdkError [${error.status}] ${error.code}: ${error.message}`);
        this.response = response;
        this.error = error;
        this.name = 'DurionSdkError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.DurionSdkError = DurionSdkError;
