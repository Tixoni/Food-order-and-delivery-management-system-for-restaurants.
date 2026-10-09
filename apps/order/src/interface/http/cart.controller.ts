import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ValidationError } from "@food-delivery/shared";
import { CurrentUser, ROLES, Roles, type AuthenticatedUser } from "@food-delivery/service-kit";
import { CartUseCases, type AddToCartInput } from "../../application/use-cases/cart.use-cases";
import { optionalNumber, requesterOf } from "./requester";

/** Корзина клиента (CART-1..4). */
@Controller("cart")
@Roles(ROLES.client)
export class CartController {
  constructor(private readonly carts: CartUseCases) {}

  /** CART-2: корзина; с координатами адреса — ещё и итог с доставкой. */
  @Get()
  async view(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query("lat") lat?: string,
    @Query("lon") lon?: string,
  ) {
    const latitude = optionalNumber(lat);
    const longitude = optionalNumber(lon);
    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new ValidationError("координаты адреса передаются парой: lat и lon");
    }
    return this.carts.view(
      requesterOf(user),
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    );
  }

  @Post("items")
  async add(@Body() body: AddToCartInput, @CurrentUser() user?: AuthenticatedUser) {
    if (!body || typeof body !== "object") throw new ValidationError("пустой запрос");
    return this.carts.add(requesterOf(user), { ...body, quantity: Number(body.quantity ?? 1) });
  }

  @Patch("items/:lineId")
  async setQuantity(
    @Param("lineId") lineId: string,
    @Body() body: { quantity?: number } | undefined,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.carts.setQuantity(requesterOf(user), lineId, Number(body?.quantity));
  }

  @Delete("items/:lineId")
  async remove(@Param("lineId") lineId: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.carts.remove(requesterOf(user), lineId);
  }

  @Delete()
  async clear(@CurrentUser() user?: AuthenticatedUser) {
    return this.carts.clear(requesterOf(user));
  }
}
