import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedUser, Role } from "./auth.types";

/**
 * Пометки доступа для обработчиков запросов.
 *
 * Порядок принят обратный привычному: доступ закрыт по умолчанию,
 * а открывается явной пометкой. Забыть закрыть метод проще, чем забыть
 * открыть: во втором случае это сразу заметно при первом же обращении,
 * в первом — обнаруживается по утечке данных (SEC-2).
 */

export const PUBLIC_KEY = "auth:public";
export const ROLES_KEY = "auth:roles";

/** Обработчик доступен без входа: меню и список ресторанов видны всем. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Обработчик доступен только перечисленным ролям. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Пользователь из проверенного токена — прямо в параметре метода. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest().user,
);
