import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import { getCorrelationId, isAppError } from "@food-delivery/shared";
import { SERVICE_NAME } from "./readiness";

/**
 * Переводит ошибки приложения в ответы клиенту.
 *
 * Без него всё, что не является ошибкой NestJS, превращается
 * в «Internal server error» с кодом 500 — и пользователь вместо
 * «нужно выбрать размер» видит «внутренняя ошибка сервера».
 *
 * Разделение здесь принципиальное:
 *
 *   ошибка приложения (нарушение правила, не найдено, конфликт)
 *     — это сообщение пользователю, текст передаётся как есть;
 *
 *   любая другая ошибка — это сбой, о котором пользователю знать
 *     нечего: наружу уходит общее сообщение, подробности остаются
 *     в журнале. Иначе в ответе окажется устройство системы.
 *
 * В каждый ответ добавляется сквозной идентификатор: по нему
 * обращение пользователя связывается с записями журнала (OBS-1).
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(@Inject(SERVICE_NAME) private readonly serviceName: string) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // Ответ формируется только для обычных запросов HTTP. У GraphQL свой
    // формат ответа со списком ошибок, и он собирает его сам: попытка
    // ответить здесь превратила бы понятное «нет прав» во «внутреннюю
    // ошибку». Ошибка передаётся дальше без изменений.
    if (host.getType<string>() !== "http") {
      throw exception;
    }

    const response = host.switchToHttp().getResponse();
    const correlationId = getCorrelationId();

    if (isAppError(exception)) {
      response.status(exception.httpStatus).json({
        code: exception.code,
        message: exception.message,
        details: exception.details,
        service: this.serviceName,
        correlationId,
      });
      return;
    }

    // Ошибки самого NestJS (неизвестный путь, неверный формат тела)
    // уже содержат корректный код и безопасный текст.
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response
        .status(exception.getStatus())
        .json(
          typeof body === "string"
            ? { message: body, service: this.serviceName, correlationId }
            : { ...(body as object), service: this.serviceName, correlationId },
        );
      return;
    }

    response.status(500).json({
      code: "INTERNAL",
      message: "внутренняя ошибка сервиса",
      service: this.serviceName,
      correlationId,
    });
  }
}
