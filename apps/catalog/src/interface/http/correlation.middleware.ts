import { Injectable, type NestMiddleware } from "@nestjs/common";
import { newCorrelationId, runWithContext } from "@food-delivery/shared";
import type { NextFunction, Request, Response } from "express";

export const CORRELATION_HEADER = "x-correlation-id";

/**
 * Первое, что происходит с каждым запросом: он получает сквозной
 * идентификатор. Если клиент прислал свой — берём его, иначе создаём новый.
 *
 * Дальше идентификатор доступен в любой точке обработки, включая обработчики
 * событий, и попадает во все записи журнала. Без него собрать картину
 * одного действия пользователя через четыре сервиса невозможно (OBS-1, OBS-2).
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === "string" && incoming.trim() !== "" ? incoming : newCorrelationId();

    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithContext({ correlationId, source: "http" }, () => next());
  }
}
