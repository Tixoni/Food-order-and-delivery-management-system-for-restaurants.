import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import {
  SpanKind,
  activeTraceId,
  continueTrace,
  startStoredSpan,
  traceHeaders,
} from "./trace-context";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

afterEach(() => exporter.reset());
afterAll(() => provider.shutdown());

const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;
const byName = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name)!;

describe("трасса через асинхронные границы (OBS-2)", () => {
  it("запрос → строка outbox → отправка → обработка: одна трасса, верные родители", async () => {
    // Запрос: событие пишется в outbox вместе с контекстом трассы
    let stored: Record<string, string> = {};
    let requestTraceId: string | undefined;
    await trace.getTracer("test").startActiveSpan("POST /orders", async (request) => {
      stored = traceHeaders();
      requestTraceId = activeTraceId();
      request.end();
    });
    expect(stored.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    // Позже, в фоне: отправка — продолжение трассы из строки outbox
    const publish = startStoredSpan({
      carrier: stored,
      name: "order.events publish",
      kind: SpanKind.PRODUCER,
    });
    publish.end();

    // Другой сервис: заголовки Kafka приходят как Buffer
    const kafkaHeaders = Object.fromEntries(
      Object.entries(publish.headers).map(([k, v]) => [k, Buffer.from(v)]),
    );
    await continueTrace(
      { carrier: kafkaHeaders, name: "order.events process", kind: SpanKind.CONSUMER },
      async () => {
        trace.getTracer("test").startSpan("UPDATE deliveries").end();
      },
    );

    const spans = exporter.getFinishedSpans();
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([requestTraceId]));
    expect(parentOf(byName("order.events publish"))).toBe(
      byName("POST /orders").spanContext().spanId,
    );
    expect(parentOf(byName("order.events process"))).toBe(
      byName("order.events publish").spanContext().spanId,
    );
    expect(parentOf(byName("UPDATE deliveries"))).toBe(
      byName("order.events process").spanContext().spanId,
    );
  });

  it("нет сохранённого контекста — новая трасса; ошибка работы отмечается и пробрасывается", async () => {
    await expect(
      continueTrace({ carrier: null, name: "saga AUTHORIZE_PAYMENT" }, async () => {
        throw new Error("провайдер не ответил");
      }),
    ).rejects.toThrow("провайдер не ответил");

    const span = byName("saga AUTHORIZE_PAYMENT");
    expect(parentOf(span)).toBeUndefined();
    expect(span.status.code).toBe(2); // ERROR
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });
});
