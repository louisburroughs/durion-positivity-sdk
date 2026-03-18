"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
/* tslint:disable */
/* eslint-disable */
__exportStar(require("./EmployeeAPIApi"), exports);
__exportStar(require("./PeopleAPIApi"), exports);
__exportStar(require("./PeopleAccessControlApi"), exports);
__exportStar(require("./PeopleAvailabilityAPIApi"), exports);
__exportStar(require("./PeopleExceptionsApi"), exports);
__exportStar(require("./PeopleReportsAPIApi"), exports);
__exportStar(require("./PeopleStaffingAssignmentsApi"), exports);
__exportStar(require("./PeopleTimeEntriesApi"), exports);
__exportStar(require("./TimeEntryApprovalAPIApi"), exports);
__exportStar(require("./UserPersonLinkingAPIApi"), exports);
__exportStar(require("./WorkSessionsAPIApi"), exports);
