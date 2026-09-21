import { Injectable, type NestMiddleware } from "@nestjs/common";
import { newCorrelationId, runWithContext } from "@food-delivery/shared";

export const CORRELATION_HEADER = "x-correlation-id";

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
      typeof incoming === "string" && incoming.trim() !== "" ? incoming : newCorrelationId();

    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithContext({ correlationId, source: "http" }, () => next());
  }
}
