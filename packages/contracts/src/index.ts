/**
 * Схемы межсервисных контрактов: имена топиков, типы событий по ним
 * и внутренний HTTP API между сервисами. Схема GraphQL — в шлюзе.
 * См. заметку «11 — Контракты API и события».
 */

export * from "./topics";
export * from "./catalog.events";
export * from "./order.events";
export * from "./payment.events";
export * from "./delivery.events";
export * from "./internal-api";
