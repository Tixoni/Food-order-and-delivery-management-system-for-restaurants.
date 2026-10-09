/**
 * Источник текущего времени.
 *
 * Сроки статусов считаются от момента перехода; в тестах время двигается
 * вперёд вручную, чтобы проверить таймауты без ожидания реальных минут.
 */
export type Clock = () => Date;

export const CLOCK = Symbol("Clock");

export const systemClock: Clock = () => new Date();
