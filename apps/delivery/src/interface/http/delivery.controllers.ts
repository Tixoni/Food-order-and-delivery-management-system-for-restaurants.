import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import {
  DELIVERY_API,
  type ReleaseCourierRequest,
  type RequestCourierRequest,
} from "@food-delivery/contracts";
import { UnauthorizedError, ValidationError } from "@food-delivery/shared";
import {
  CurrentUser,
  InternalTokenGuard,
  Public,
  ROLES,
  Roles,
  type AuthenticatedUser,
} from "@food-delivery/service-kit";
import {
  CourierUseCase,
  type CourierRequester,
  type LocationInput,
} from "../../application/use-cases/courier.use-case";
import { DispatchUseCase } from "../../application/use-cases/dispatch.use-case";
import { TrackingUseCase } from "../../application/use-cases/tracking.use-case";

const requesterOf = (user: AuthenticatedUser | undefined): CourierRequester => {
  if (!user) throw new UnauthorizedError("требуется вход в систему");
  return { userId: user.id };
};

/**
 * Внутренний API для оркестратора саги (`DELIVERY_API` из контрактов).
 * Пользовательского токена здесь нет — вызывает `order`, со служебным токеном.
 */
@Controller()
@Public()
@UseGuards(InternalTokenGuard)
export class InternalDeliveryController {
  constructor(private readonly dispatch: DispatchUseCase) {}

  @Post(DELIVERY_API.request)
  @HttpCode(200)
  request(@Body() body: RequestCourierRequest) {
    return this.dispatch.requestCourier(body ?? ({} as RequestCourierRequest));
  }

  @Post(DELIVERY_API.release)
  @HttpCode(200)
  release(@Body() body: ReleaseCourierRequest) {
    return this.dispatch.releaseCourier(body ?? ({} as ReleaseCourierRequest));
  }
}

/** Приложение курьера: смена, позиция, предложения, отметки (DLV-1, 2, 4, 5). */
@Controller()
@Roles(ROLES.courier)
export class CourierController {
  constructor(private readonly couriers: CourierUseCase) {}

  @Get("couriers/me")
  me(@CurrentUser() user?: AuthenticatedUser) {
    return this.couriers.dashboard(requesterOf(user));
  }

  @Post("couriers/me/shift")
  @HttpCode(200)
  shift(@Body() body: { onShift?: boolean }, @CurrentUser() user?: AuthenticatedUser) {
    if (typeof body?.onShift !== "boolean") throw new ValidationError("onShift: true или false");
    return this.couriers.setShift(requesterOf(user), body.onShift);
  }

  @Post("couriers/me/location")
  @HttpCode(202)
  location(@Body() body: LocationInput, @CurrentUser() user?: AuthenticatedUser) {
    return this.couriers.updateLocation(requesterOf(user), body ?? ({} as LocationInput));
  }

  @Post("offers/:offerId/accept")
  @HttpCode(200)
  accept(@Param("offerId") offerId: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.couriers.accept(requesterOf(user), offerId);
  }

  @Post("offers/:offerId/reject")
  @HttpCode(200)
  reject(@Param("offerId") offerId: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.couriers.reject(requesterOf(user), offerId);
  }

  @Post("deliveries/:deliveryId/picked-up")
  @HttpCode(200)
  pickedUp(@Param("deliveryId") deliveryId: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.couriers.pickedUp(requesterOf(user), deliveryId);
  }

  @Post("deliveries/:deliveryId/delivered")
  @HttpCode(200)
  delivered(@Param("deliveryId") deliveryId: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.couriers.delivered(requesterOf(user), deliveryId);
  }
}

/** Позиция курьера для клиента заказа и оператора (TRK-2, SEC-7). */
@Controller()
export class TrackingController {
  constructor(private readonly tracking: TrackingUseCase) {}

  @Roles(ROLES.client, ROLES.operator, ROLES.admin)
  @Get("orders/:orderId/courier-position")
  position(@Param("orderId") orderId: string, @CurrentUser() user?: AuthenticatedUser) {
    if (!user) throw new UnauthorizedError("требуется вход в систему");
    return this.tracking.courierPosition(orderId, { userId: user.id, roles: user.roles });
  }
}

/** ADM-2: курьеры заводятся администратором. */
@Controller("couriers")
@Roles(ROLES.admin)
export class AdminCouriersController {
  constructor(private readonly tracking: TrackingUseCase) {}

  @Get()
  list() {
    return this.tracking.listCouriers();
  }

  @Post()
  register(
    @Body()
    body: {
      fullName?: string;
      phone?: string | null;
      vehicleType?: string;
      userId?: string | null;
    },
  ) {
    return this.tracking.registerCourier(body ?? {});
  }
}
