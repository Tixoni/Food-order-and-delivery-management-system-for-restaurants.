import { Body, Controller, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { Query } from "@nestjs/common";
import { ValidationError } from "@food-delivery/shared";
import {
  CurrentUser,
  Public,
  ROLES,
  Roles,
  type AuthenticatedUser,
} from "@food-delivery/service-kit";
import { FindRestaurantsForAddressUseCase } from "../../application/use-cases/find-restaurants-for-address.use-case";
import { ListRestaurantsUseCase } from "../../application/use-cases/list-restaurants.use-case";
import { ManageRestaurantUseCase } from "../../application/use-cases/manage-restaurant.use-case";
import { ManageRestaurantScheduleUseCase } from "../../application/use-cases/manage-restaurant-schedule.use-case";
import {
  ValidateCartUseCase,
  type ValidateCartInput,
} from "../../application/use-cases/validate-cart.use-case";
import type { ScheduleInterval } from "../../domain/restaurant-schedule";
import { assertManagesRestaurant } from "./restaurant-access";
import type { DeliveryOffer } from "../../application/ports/delivery-zone.repository";
import type { Restaurant } from "../../domain/restaurant";

/**
 * Слой интерфейса: принимает запрос, вызывает сценарий, превращает
 * доменные объекты в ответ. Бизнес-правил здесь нет — только преобразование.
 *
 * Доменный объект наружу не отдаётся: иначе внутреннее устройство домена
 * станет частью внешнего контракта, и его нельзя будет менять.
 */
interface RestaurantResponse {
  id: string;
  name: string;
  minOrderAmount: number;
  deliveryFee: number;
  avgCookingTimeMin: number;
}

const toResponse = (restaurant: Restaurant): RestaurantResponse => ({
  id: restaurant.id,
  name: restaurant.name,
  minOrderAmount: restaurant.minOrderAmount,
  deliveryFee: restaurant.deliveryFeeBase,
  avgCookingTimeMin: restaurant.avgCookingTimeMin,
});

/**
 * Ресторан в выдаче по адресу: к обычным сведениям добавлены условия
 * доставки той зоны, в которую попал адрес клиента.
 */
const offerToResponse = (offer: DeliveryOffer) => ({
  ...toResponse(offer.restaurant),
  deliveryFee: offer.deliveryFee,
  minOrderAmount: offer.minOrderAmount,
  zone: { id: offer.zoneId, name: offer.zoneName },
});

interface RegisterBody {
  name: string;
  description?: string | null;
  phone?: string | null;
  addressText?: string | null;
  location?: { latitude: number; longitude: number } | null;
  minOrderAmount?: number;
  deliveryFeeBase?: number;
  avgCookingTimeMin?: number;
  timeZone?: string;
}

interface UpdateBody extends Partial<RegisterBody> {
  isActive?: boolean;
}

/** Полные сведения о ресторане — для администратора и менеджера. */
const toDetailedResponse = (restaurant: Restaurant) => ({
  ...toResponse(restaurant),
  description: restaurant.description,
  phone: restaurant.phone,
  addressText: restaurant.addressText,
  location: restaurant.location
    ? { latitude: restaurant.location.latitude, longitude: restaurant.location.longitude }
    : null,
  isActive: restaurant.isActive,
  timeZone: restaurant.timeZone,
});

/** Число из строки запроса. Пустое и нечисловое значение — ошибка пользователя. */
const requiredNumber = (value: string | undefined, name: string): number => {
  if (value === undefined || value.trim() === "") {
    throw new ValidationError(`не указан обязательный параметр ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`параметр ${name} должен быть числом`, { [name]: value });
  }
  return parsed;
};

@Controller("restaurants")
export class RestaurantsController {
  constructor(
    private readonly listRestaurants: ListRestaurantsUseCase,
    private readonly findForAddress: FindRestaurantsForAddressUseCase,
    private readonly manageRestaurant: ManageRestaurantUseCase,
    private readonly schedules: ManageRestaurantScheduleUseCase,
    private readonly validateCart: ValidateCartUseCase,
  ) {}

  @Public()
  @Post(":restaurantId/validate-cart")
  async validate(
    @Param("restaurantId") restaurantId: string,
    @Body() body: Omit<ValidateCartInput, "restaurantId">,
  ) {
    return this.validateCart.execute({ ...body, restaurantId });
  }

  @Public()
  @Get(":restaurantId/schedule")
  async schedule(@Param("restaurantId") restaurantId: string) {
    return this.schedules.get(restaurantId);
  }

  @Public()
  @Get(":restaurantId/orderability")
  async orderability(@Param("restaurantId") restaurantId: string) {
    return this.schedules.orderability(restaurantId);
  }

  @Roles(ROLES.manager, ROLES.admin)
  @Put(":restaurantId/schedule")
  async replaceSchedule(
    @Param("restaurantId") restaurantId: string,
    @Body() body: { intervals: ScheduleInterval[] },
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    assertManagesRestaurant(user, restaurantId);
    return this.schedules.replace(restaurantId, body.intervals);
  }

  /**
   * ADM-2: администратор регистрирует ресторан.
   *
   * Именно администратор площадки, а не сам ресторан: в каталоге не должно
   * появляться заведений, с которыми нет договора.
   */
  @Roles(ROLES.admin)
  @Post()
  async register(@Body() body: RegisterBody) {
    return toDetailedResponse(await this.manageRestaurant.register(body));
  }

  /** ADM-2: правка сведений о ресторане и его закрытие. */
  @Roles(ROLES.admin)
  @Patch(":restaurantId")
  async update(@Param("restaurantId") restaurantId: string, @Body() body: UpdateBody) {
    return toDetailedResponse(await this.manageRestaurant.update({ ...body, restaurantId }));
  }

  /**
   * CAT-1: какие рестораны доставляют по этому адресу.
   *
   * Координаты, а не текст адреса: перевод адреса в точку на карте
   * выполняет клиентская часть, где уже есть карта и справочник адресов.
   */
  @Public()
  @Get("delivery-to")
  async deliveryTo(
    @Query("lat") lat?: string,
    @Query("lon") lon?: string,
    @Query("limit") limit?: string,
  ) {
    const offers = await this.findForAddress.execute({
      latitude: requiredNumber(lat, "lat"),
      longitude: requiredNumber(lon, "lon"),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });

    return { items: offers.map(offerToResponse), total: offers.length };
  }

  /**
   * Один ресторан. Объявлен после `delivery-to`: маршруты сопоставляются
   * по порядку, и `:restaurantId` иначе перехватил бы поиск по адресу.
   */
  @Public()
  @Get(":restaurantId")
  async one(@Param("restaurantId") restaurantId: string) {
    return toResponse(await this.listRestaurants.getOne(restaurantId));
  }

  @Public()
  @Get()
  async list(@Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    const result = await this.listRestaurants.execute({
      ...(page !== undefined ? { page: Number(page) } : {}),
      ...(pageSize !== undefined ? { pageSize: Number(pageSize) } : {}),
    });

    return {
      items: result.items.map(toResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}
