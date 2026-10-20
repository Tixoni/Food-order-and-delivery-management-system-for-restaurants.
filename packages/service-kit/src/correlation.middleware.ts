import { Injectable, type NestMiddleware } from "@nestjs/common";
import { newCorrelationId, runWithContext } from "@food-delivery/shared";
import { activeTraceId } from "./trace-context";

export const CORRELATION_HEADER = "x-correlation-id";
export const TRACE_HEADER = "x-trace-id";

/**
 * Какой идентификатор от вызывающего принимается. Он попадает в каждую запись
 * журнала, в заголовки сообщений брокера и в базы сервисов (в delivery —
 * колонка VARCHAR(100)): длинная или произвольная строка от клиента сорвала
 * бы там запись — вызов курьера по такому заказу не прошёл бы никогда.
 */
const ACCEPTED_ID = /^[A-Za-z0-9._:-]{1,100}$/;

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface MinimalResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Первое, что происходит с каждым запросом: он получает сквозной идентификатор.
 * Прислал клиент свой — берём его, иначе создаём новый.
 *
 * Дальше идентификатор доступен в любой точке обработки и попадает во все
 * записи журнала. Без него собрать картину одного действия пользователя
 * через пять процессов невозможно (OBS-1, OBS-2).
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: MinimalRequest, res: MinimalResponse, next: () => void) {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === "string" && ACCEPTED_ID.test(incoming) ? incoming : newCorrelationId();

    res.setHeader(CORRELATION_HEADER, correlationId);
    // Номер трассы — в ответе: по нему обращение находится в Jaeger (OBS-2)
    const traceId = activeTraceId();
    if (traceId) res.setHeader(TRACE_HEADER, traceId);
    runWithContext({ correlationId, source: "http" }, () => next());
  }
}
