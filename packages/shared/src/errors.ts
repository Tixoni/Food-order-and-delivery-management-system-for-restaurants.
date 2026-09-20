/**
 * Ошибки приложения.
 *
 * Единый формат нужен по двум причинам: шлюз должен уметь превратить любую
 * ошибку в понятный клиенту ответ, а оркестратор саги — отличить ошибку,
 * которую имеет смысл повторить, от той, которую повторять бессмысленно.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "DOMAIN_RULE_VIOLATED"
  | "EXTERNAL_SERVICE_FAILED"
  | "TIMEOUT"
  | "INTERNAL";

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;

  /**
   * Имеет ли смысл повторить операцию.
   * Оркестратор саги повторяет только такие ошибки; остальные сразу
   * запускают компенсацию, не тратя попытки впустую.
   */
  readonly retryable: boolean = false;

  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_FAILED" as const;
  readonly httpStatus = 400;
}

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
  readonly httpStatus = 401;
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
  readonly httpStatus = 403;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly httpStatus = 404;
}

/** Нарушение инварианта: например, попытка недопустимого перехода статуса заказа. */
export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const;
  readonly httpStatus = 409;
}

export class DomainRuleError extends AppError {
  readonly code = "DOMAIN_RULE_VIOLATED" as const;
  readonly httpStatus = 422;
}

/** Внешняя система не ответила или ответила ошибкой — повтор осмыслен. */
export class ExternalServiceError extends AppError {
  readonly code = "EXTERNAL_SERVICE_FAILED" as const;
  readonly httpStatus = 502;
  override readonly retryable = true;
}

export class TimeoutError extends AppError {
  readonly code = "TIMEOUT" as const;
  readonly httpStatus = 504;
  override readonly retryable = true;
}

export class InternalError extends AppError {
  readonly code = "INTERNAL" as const;
  readonly httpStatus = 500;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isRetryable(error: unknown): boolean {
  return isAppError(error) && error.retryable;
}
