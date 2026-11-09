import { HttpException, HttpStatus } from '@nestjs/common';

/** Machine-readable error codes the clients switch on. */
export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOTP_REQUIRED'
  | 'TOTP_INVALID'
  | 'INVALID_CREDENTIALS'
  | 'QUOTA_EXCEEDED'
  | 'ACCOUNT_READ_ONLY'
  | 'RATE_LIMITED'
  | 'PASSWORD_REQUIRED'
  | 'LINK_EXPIRED'
  | 'PROVIDER_UNAVAILABLE'
  | 'UPLOAD_INVALID'
  | 'BAD_ORIGIN';

export class AppError extends HttpException {
  constructor(status: HttpStatus, public readonly code: ErrorCode, message: string, extra?: Record<string, unknown>) {
    super({ code, message, ...extra }, status);
  }
}

export const Errors = {
  notFound: (what = 'Resource') => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`),
  forbidden: (msg = 'Forbidden') => new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', msg),
  unauth: (msg = 'Authentication required') => new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', msg),
  conflict: (msg: string) => new AppError(HttpStatus.CONFLICT, 'CONFLICT', msg),
  quota: (needed: number, available: number) =>
    new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'QUOTA_EXCEEDED', 'Not enough storage. Free up space or upgrade your plan.', { needed, available }),
  readOnly: () =>
    new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_READ_ONLY', 'Your account is read-only because it is over quota. Delete files or upgrade.'),
  bad: (msg: string, code: ErrorCode = 'VALIDATION') => new AppError(HttpStatus.BAD_REQUEST, code, msg),
};
