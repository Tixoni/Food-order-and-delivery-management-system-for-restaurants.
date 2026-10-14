import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation, ExpressLayerType } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/** Проверки живости и сбор метрик — не трассируются: шум без смысла. */
const QUIET_PATHS = ["/health", "/ready", "/metrics"];

let provider: NodeTracerProvider | null = null;

/**
 * Сквозная трассировка (OBS-2): OpenTelemetry → OTLP → Jaeger.
 *
 * Вызывается первой строкой сервиса — отдельным модулем `tracing.ts`,
 * подключённым раньше всего остального: инструментации подменяют модули
 * (http, express, pg, ioredis) в момент их загрузки, и загруженное до
 * этого останется без трасс. Поэтому модуль не входит в общий index
 * каркаса — тот тянет ioredis и kafkajs.
 *
 * Включается переменной OTEL_EXPORTER_OTLP_ENDPOINT (стандарт OpenTelemetry);
 * без неё — выключено: тесты и запуск на машине разработчика без Jaeger
 * не копят и не отправляют участки трасс.
 *
 * Внутри процесса трассу ведут инструментации, между сервисами по HTTP —
 * заголовок `traceparent`. Через брокер и таймеры саги трассу переносит
 * код каркаса: см. trace-context.ts, outbox-relay.ts, reliable-consumer.ts.
 */
export function startTracing(serviceName: string): void {
  if (provider || process.env.OTEL_SDK_DISABLED === "true") return;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": serviceName }),
    // Участки копятся и уходят пачками в фоне: запрос не ждёт Jaeger, а
    // недоступный Jaeger не мешает сервису работать.
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  // Регистрирует распространение W3C Trace Context и хранение контекста
  // в AsyncLocalStorage — так же, как сквозной идентификатор журнала.
  provider.register();

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) =>
          QUIET_PATHS.some((path) => request.url?.startsWith(path) ?? false),
      }),
      // fetch — межсервисные вызовы (InternalHttpClient) и обращения к Keycloak, OSRM
      new UndiciInstrumentation(),
      // Имя участка — шаблон маршрута; промежуточные слои — без своих участков
      new ExpressInstrumentation({
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.ROUTER],
      }),
      // Без участков «взять соединение из пула» — по одному на каждый запрос,
      // в трассе это шум, а не информация
      new PgInstrumentation({ requireParentSpan: true, ignoreConnectSpans: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });
}

/** Отправить накопленные участки перед остановкой — иначе последние потеряются. */
export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown().catch(() => undefined);
}
