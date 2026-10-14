import { Kafka, type Consumer, type Producer } from "kafkajs";
import {
  ConflictError,
  isRetryable,
  parseEvent,
  runWithContext,
  type DomainEvent,
  type Logger,
} from "@food-delivery/shared";
import { retry } from "../resilience/retry";
import { SpanKind, continueTrace } from "../trace-context";
import { ensureTopics, errorText } from "./kafka-topics";

export interface MessageMeta {
  topic: string;
  partition: number;
  offset: string;
  /** Заголовки сообщения — среди них контекст трассы отправителя. */
  headers?: Record<string, unknown>;
}

export interface ReliableConsumerOptions {
  kafka: { brokers: string[]; clientId: string };
  groupId: string;
  topics: readonly string[];
  /** Имя очереди необработанных сообщений для топика — из packages/contracts. */
  deadLetterTopic: (topic: string) => string;
  /**
   * Обработка одного события. Защиту от повторной доставки (REL-4) обеспечивает
   * сам обработчик — там, где она нужна: вставкой messageId в inbox_messages
   * той же транзакцией, что и изменение данных.
   */
  handle: (event: DomainEvent, meta: MessageMeta) => Promise<void>;
  retry: { attempts: number; baseDelayMs: number; maxDelayMs: number };
  logger: Logger;
  /** Как часто повторять подключение, если брокер недоступен. */
  reconnectIntervalMs?: number;
  /** Подменяется в тестах. */
  sleep?: (ms: number) => Promise<void>;
}

/** Что произошло с сообщением — для тестов и журнала. */
export type HandlingOutcome = "handled" | "dead-lettered";

/**
 * Надёжный потребитель событий.
 *
 * Три вещи, которых нет в «голом» потребителе брокера:
 *
 *   повторы — временный сбой (база перезапускается, конфликт версий
 *     при одновременном изменении) не превращается в потерю события:
 *     обработка повторяется с нарастающей задержкой;
 *
 *   очередь необработанных (DLQ) — сообщение, которое не удаётся
 *     обработать и после повторов, уходит в `<топик>.dlq` с причиной.
 *     Иначе остаются два плохих варианта: молча пропустить (потеря)
 *     или бесконечно повторять (одно испорченное сообщение навсегда
 *     останавливает всю партицию). Непустая DLQ — дефект, который
 *     разбирает оператор, а не норма;
 *
 *   переподключение — запуск сервиса при выключенном брокере не отключает
 *     приём событий навсегда: подключение повторяется в фоне.
 *
 * Обработка продолжает сквозной идентификатор отправителя: все записи
 * журнала об одном действии пользователя находятся одним запросом (OBS-1).
 */
export class ReliableConsumer {
  private readonly kafka: Kafka;
  private consumer: Consumer | null = null;
  private dlqProducer: Producer | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  private stopped = false;

  constructor(private readonly options: ReliableConsumerOptions) {
    this.kafka = new Kafka({
      clientId: options.kafka.clientId,
      brokers: options.kafka.brokers,
      retry: { initialRetryTime: 300, retries: 3 },
      logCreator: () => () => {},
    });
  }

  get connected(): boolean {
    return this.consumer !== null;
  }

  async start(): Promise<void> {
    await this.connect();
    if (!this.consumer && !this.stopped) {
      this.reconnectTimer = setInterval(
        () => void this.connect(),
        this.options.reconnectIntervalMs ?? 5000,
      );
      this.reconnectTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.consumer?.disconnect().catch(() => undefined);
    await this.dlqProducer?.disconnect().catch(() => undefined);
    this.consumer = null;
    this.dlqProducer = null;
  }

  /**
   * Обработка одного сообщения: разбор, повторы, при неудаче — DLQ.
   * Открыт для тестов: проверять логику повторов через живой брокер незачем.
   */
  async process(raw: string | undefined, meta: MessageMeta): Promise<HandlingOutcome> {
    // Обработка — продолжение трассы отправителя (OBS-2): участок
    // потребителя дочерний к участку отправки, всё, что делает обработчик, —
    // дочернее к нему.
    return continueTrace(
      {
        carrier: meta.headers,
        name: `${meta.topic} process`,
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.system": "kafka",
          "messaging.destination.name": meta.topic,
          "messaging.operation.type": "process",
          "messaging.consumer.group.name": this.options.groupId,
        },
      },
      () => this.handleMessage(raw, meta),
    );
  }

  private async handleMessage(
    raw: string | undefined,
    meta: MessageMeta,
  ): Promise<HandlingOutcome> {
    let event: DomainEvent;
    try {
      event = parseEvent(JSON.parse(raw ?? ""));
    } catch (error) {
      // Неразобранное сообщение повторять бессмысленно — сразу в DLQ.
      await this.deadLetter(raw, meta, `сообщение не разобрано: ${errorText(error)}`, 0);
      return "dead-lettered";
    }

    let attempts = 0;
    try {
      await runWithContext(
        { correlationId: event.correlationId, causationId: event.messageId, source: "kafka" },
        () =>
          retry(
            async (attempt) => {
              attempts = attempt;
              await this.options.handle(event, meta);
            },
            {
              ...this.options.retry,
              ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
              // Конфликт версий — гонка с одновременной командой: после
              // перечитывания состояния обработка обычно проходит.
              retryOn: (error) => isRetryable(error) || error instanceof ConflictError,
              onRetry: (error, attempt, delayMs) =>
                this.options.logger.warn("повтор обработки события", {
                  eventType: event.eventType,
                  messageId: event.messageId,
                  attempt,
                  delayMs,
                  error: errorText(error),
                }),
            },
          ),
      );
      return "handled";
    } catch (error) {
      await this.deadLetter(raw, meta, errorText(error), attempts, event);
      return "dead-lettered";
    }
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.consumer || this.stopped) return;
    this.connecting = true;
    let consumer: Consumer | null = null;
    try {
      const { topics, deadLetterTopic } = this.options;
      // Топик создаёт первый, кому он понадобился: потребитель может
      // подняться раньше отправителя.
      await ensureTopics(this.kafka, [...topics, ...topics.map((topic) => deadLetterTopic(topic))]);

      consumer = this.kafka.consumer({ groupId: this.options.groupId });
      await consumer.connect();
      for (const topic of topics) await consumer.subscribe({ topic, fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          await this.process(message.value?.toString("utf8"), {
            topic,
            partition,
            offset: message.offset,
            headers: message.headers as Record<string, unknown> | undefined,
          });
        },
      });

      this.consumer = consumer;
      if (this.reconnectTimer) clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
      this.options.logger.info("подписка на события установлена", {
        topics,
        group: this.options.groupId,
      });
    } catch (error) {
      this.options.logger.warn("не удалось подписаться на события", {
        topics: this.options.topics,
        error: errorText(error),
      });
      await consumer?.disconnect().catch(() => undefined);
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Перенос сообщения в DLQ с причиной. Если и это не удалось — ошибка
   * уходит брокеру: сообщение будет прочитано снова, но не потеряно.
   */
  private async deadLetter(
    raw: string | undefined,
    meta: MessageMeta,
    reason: string,
    attempts: number,
    event?: DomainEvent,
  ): Promise<void> {
    const topic = this.options.deadLetterTopic(meta.topic);
    this.options.logger.error("событие перенесено в очередь необработанных", undefined, {
      topic: meta.topic,
      deadLetterTopic: topic,
      eventType: event?.eventType,
      messageId: event?.messageId,
      attempts,
      reason,
    });

    if (!this.dlqProducer) {
      const producer = this.kafka.producer({ allowAutoTopicCreation: false });
      await producer.connect();
      this.dlqProducer = producer;
    }
    await this.dlqProducer.send({
      topic,
      messages: [
        {
          key: event?.aggregateId ?? null,
          value: raw ?? "",
          headers: {
            "x-original-topic": meta.topic,
            "x-original-partition": String(meta.partition),
            "x-original-offset": meta.offset,
            "x-error": reason.slice(0, 1000),
            "x-attempts": String(attempts),
            "x-failed-at": new Date().toISOString(),
          },
        },
      ],
    });
  }
}
