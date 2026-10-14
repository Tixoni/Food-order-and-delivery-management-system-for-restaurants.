/**
 * Трассировка (OBS-2) — первым делом, до загрузки остального кода:
 * инструментации подменяют http, express, pg, ioredis при их загрузке.
 * Выключена, пока не задан OTEL_EXPORTER_OTLP_ENDPOINT.
 */
import { startTracing } from "@food-delivery/service-kit/dist/tracing";

startTracing("delivery");
