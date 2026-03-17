/* tslint:disable */
/* eslint-disable */

export interface DurionApiError {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** HTTP status code. */
  status: number;
  /** ISO 8601 timestamp of when the error occurred. */
  timestamp: string;
  /** Correlation ID for tracing the request. */
  correlationId: string;
  /** Per-field validation errors, present on 400 responses. */
  fieldErrors?: Array<{ field: string; message: string }>;
  /** Reference ID for support lookup. */
  referenceId?: string;
  /** Suggested next action for the caller. */
  nextAction?: string;
  /** Support action message. */
  supportAction?: string;
}

export class DurionSdkError extends Error {
  constructor(
    public readonly response: Response,
    public readonly error: DurionApiError,
  ) {
    super(`DurionSdkError [${error.status}] ${error.code}: ${error.message}`);
    this.name = 'DurionSdkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
