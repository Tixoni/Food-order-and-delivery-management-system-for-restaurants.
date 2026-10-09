/**
 * Схемы межсервисных контрактов.
 *
 * Здесь: имена топиков и типы событий по ним (шаг 1.2 и далее),
 * описания gRPC-вызовов и схема GraphQL шлюза.
 * См. заметку «11 — Контракты API и события».
 */
export const CONTRACTS_VERSION = "0.1.0";

export * from "./topics";
export * from "./catalog.events";
export * from "./order.events";
export * from "./payment.events";
export * from "./delivery.events";
export * from "./internal-api";
