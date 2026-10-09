import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { CurrentUser, ROLES, Roles, type AuthenticatedUser } from "@food-delivery/service-kit";
import { OrderCommandsUseCase } from "../../application/use-cases/order-commands.use-case";
import { OrderQueriesUseCase } from "../../application/use-cases/order-queries.use-case";
import { ORDER_READ_MODEL, type OrderReadModel } from "../../application/ports/order-read-model";
import { optionalNumber, requesterOf } from "./requester";

/** Экран оператора поддержки (ADM-3): поиск, очередь «нужно внимание», отмена. */
@Controller("operator/orders")
export class OperatorController {
  constructor(
    private readonly commands: OrderCommandsUseCase,
    private readonly queries: OrderQueriesUseCase,
    @Inject(ORDER_READ_MODEL) private readonly read: OrderReadModel,
  ) {}

  /**
   * Поиск заказов. `attention=true` — очередь заказов, у которых истёк срок
   * без автоматического решения: затянувшаяся готовка, курьер не найден,
   * компенсация не проходит.
   */
  @Roles(ROLES.operator, ROLES.admin)
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query("status") status?: string,
    @Query("attention") attention?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const statuses = status
      ? status
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined;
    const limitValue = optionalNumber(limit);
    const offsetValue = optionalNumber(offset);
    const items = await this.queries.list(requesterOf(user), {
      ...(statuses ? { statuses } : {}),
      attentionOnly: attention === "true",
      ...(limitValue !== undefined ? { limit: limitValue } : {}),
      ...(offsetValue !== undefined ? { offset: offsetValue } : {}),
    });
    return { items };
  }

  /** ORD-6: отмена на любом этапе; после списания — полный или частичный возврат. */
  @Roles(ROLES.operator, ROLES.admin)
  @HttpCode(200)
  @Post(":orderId/cancel")
  async cancel(
    @Param("orderId") orderId: string,
    @Body() body: { reason?: string; refundAmount?: number | null } | undefined,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    await this.commands.cancelByOperator(
      orderId,
      requesterOf(user),
      body?.reason ?? "",
      body?.refundAmount ?? null,
    );
    return this.read.get(orderId);
  }

  /** Оператор разобрался с заказом из очереди «нужно внимание». */
  @Roles(ROLES.operator, ROLES.admin)
  @HttpCode(200)
  @Post(":orderId/attention/clear")
  async clearAttention(@Param("orderId") orderId: string, @CurrentUser() user?: AuthenticatedUser) {
    await this.commands.clearAttention(orderId, requesterOf(user));
    return this.read.get(orderId);
  }
}
