import { ConflictError, DomainRuleError } from "@food-delivery/shared";
import { DeliveryConflictError, DeliveryRuleError } from "../domain/delivery-errors";

/** Ошибки домена → ошибки приложения: правило — 422, опоздание — 409. */
export function toAppError(error: unknown): unknown {
  if (error instanceof DeliveryRuleError) return new DomainRuleError(error.message, error.details);
  if (error instanceof DeliveryConflictError)
    return new ConflictError(error.message, error.details);
  return error;
}

export async function domainCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toAppError(error);
  }
}
