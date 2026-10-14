import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  isSpanContextValid,
  propagation,
  trace,
  type Attributes,
} from "@opentelemetry/api";

/**
 * Контекст трассы через асинхронные границы (OBS-2).
 *
 * Внутри одного запроса трассу ведут инструментации (HTTP, fetch, pg,
 * Redis). Рвётся она там, где работа откладывается: событие пишется в
 * outbox в запросе, а уходит в брокер позже фоновым отправщиком; шаг
 * саги ставится в запросе, а выполняется фоновым исполнителем. Поэтому
 * контекст сохраняется рядом с отложенной работой — в заголовках строки
 * outbox, в строке таймера — и восстанавливается, когда работа выполняется.
 *
 * Формат — W3C Trace Context (`traceparent`), тот же, что в заголовках HTTP.
 * Без включённой трассировки функции ничего не делают и ничего не пишут.
 */

const tracer = () => trace.getTracer("food-delivery");

/** Заголовки текущей трассы для сохранения рядом с отложенной работой. */
export function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Идентификатор текущей трассы — для журнала и ответа клиенту; нет трассы — undefined. */
export function activeTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}

export interface StoredTraceOptions {
  /** Сохранённые заголовки трассы (traceparent, tracestate); нет — новая трасса. */
  carrier: Record<string, unknown> | null | undefined;
  name: string;
  kind?: SpanKind;
  attributes?: Attributes;
}

/**
 * Выполнить отложенную работу как продолжение сохранённой трассы: участок
 * с именем `name` становится дочерним к тому, где работу поставили, а всё,
 * что работа вызовет (запросы к базе, HTTP, события), — дочерним к нему.
 */
export async function continueTrace<T>(
  options: StoredTraceOptions,
  work: (headers: () => Record<string, string>) => Promise<T>,
): Promise<T> {
  const parent = propagation.extract(ROOT_CONTEXT, toStringRecord(options.carrier));
  const span = tracer().startSpan(
    options.name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes },
    parent,
  );
  const active = trace.setSpan(parent, span);
  try {
    const result = await context.with(active, () =>
      work(() => {
        const carrier: Record<string, string> = {};
        propagation.inject(active, carrier);
        return carrier;
      }),
    );
    span.end();
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message });
    span.end();
    throw error;
  }
}

export interface StoredSpan {
  /** Заголовки, продолжающие трассу этим участком, — для сообщения в брокер. */
  headers: Record<string, string>;
  end(error?: unknown): void;
}

/**
 * Участок-продолжение сохранённой трассы без обёртки над работой — для
 * пачки, где у каждого сообщения своя трасса, а отправка одна.
 */
export function startStoredSpan(options: StoredTraceOptions): StoredSpan {
  const parent = propagation.extract(ROOT_CONTEXT, toStringRecord(options.carrier));
  const span = tracer().startSpan(
    options.name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes },
    parent,
  );
  const headers: Record<string, string> = {};
  propagation.inject(trace.setSpan(parent, span), headers);
  return {
    headers,
    end(error?: unknown) {
      if (error !== undefined) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message });
      }
      span.end();
    },
  };
}

/** Значения заголовков Kafka — строки или Buffer; для извлечения нужны строки. */
export function toStringRecord(
  carrier: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(carrier ?? {})) {
    if (typeof value === "string") result[key] = value;
    else if (Buffer.isBuffer(value)) result[key] = value.toString("utf8");
  }
  return result;
}

export { SpanKind };
