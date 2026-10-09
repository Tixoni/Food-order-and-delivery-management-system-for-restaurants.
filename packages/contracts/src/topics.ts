/**
 * Имена топиков брокера — в одном месте.
 *
 * Строка с именем топика, написанная от руки в каждом сервисе, рано или
 * поздно расходится на одну букву, и сообщение уходит в никуда: брокер
 * настроен не создавать топики самостоятельно, поэтому отправка
 * в несуществующий топик — ошибка, а не молчаливая потеря.
 *
 * См. заметку «11 — Контракты API и события».
 */
export const TOPICS = {
  order: "order.events",
  payment: "payment.events",
  delivery: "delivery.events",
  catalog: "catalog.events",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

/** Очередь необработанных сообщений: к каждому топику своя. */
export const deadLetterTopic = (topic: TopicName): string => `${topic}.dlq`;
