import type { DomainEvent } from "@food-delivery/shared";
import type { Courier } from "../../domain/courier";
import type { Delivery, Offer } from "../../domain/delivery";

/**
 * Хранилище доставки.
 *
 * Изменения идут через транзакцию (`transaction`), в которой каждая
 * прочитанная запись заблокирована до конца транзакции. Так подбор
 * с двух экземпляров сервиса не предложит одного курьера двум заказам
 * и не предложит один заказ двум курьерам: кандидат выбирается с
 * пропуском заблокированных строк, доставка — под блокировкой.
 * Отдельная распределённая блокировка в Redis не нужна — её роль
 * выполняет строка в базе.
 */

export interface Candidate {
  courier: Courier;
  distanceMeters: number;
}

export interface DeliveryTx {
  deliveryById(id: string): Promise<Delivery | null>;
  activeDeliveryByOrder(orderId: string): Promise<Delivery | null>;
  /** Вторая действующая доставка по заказу — `DuplicateDeliveryError`. */
  insertDelivery(delivery: Delivery): Promise<void>;
  saveDelivery(delivery: Delivery): Promise<void>;

  courierById(id: string): Promise<Courier | null>;
  courierByUser(userId: string): Promise<Courier | null>;
  insertCourier(courier: Courier): Promise<void>;
  saveCourier(courier: Courier): Promise<void>;
  openShift(courierId: string, at: Date): Promise<void>;
  closeShift(courierId: string, at: Date): Promise<void>;

  /**
   * DLV-3: ближайший свободный курьер со свежей позицией в радиусе от точки
   * выдачи, которому этот заказ не предлагали в текущем раунде поиска.
   * Строка курьера блокируется; занятые другими транзакциями пропускаются.
   */
  nearestCandidate(
    delivery: Delivery,
    radiusMeters: number,
    freshSeconds: number,
  ): Promise<Candidate | null>;

  openOfferOf(deliveryId: string): Promise<Offer | null>;
  offerById(id: string): Promise<Offer | null>;
  offersCount(deliveryId: string): Promise<number>;
  insertOffer(offer: Offer): Promise<void>;
  saveOffer(offer: Offer): Promise<void>;
  /** Открытые предложения с истёкшим сроком, с пропуском заблокированных. */
  dueOffers(now: Date, limit: number): Promise<Offer[]>;

  /** Событие — той же транзакцией, что и изменение (REL-3); ключ партиции — заказ. */
  enqueue(events: DomainEvent[], orderId: string): Promise<void>;
}

export interface CourierDashboard {
  courier: Courier;
  offer: { offer: Offer; delivery: Delivery } | null;
  delivery: Delivery | null;
}

export interface LocationContext {
  courierId: string;
  status: string;
  /** Заказ, который курьер везёт или которому идёт навстречу, — для рассылки клиенту. */
  orderId: string | null;
}

export interface DeliveryRepository {
  transaction<T>(work: (tx: DeliveryTx) => Promise<T>): Promise<T>;

  /** Экран курьера: он сам, открытое предложение и текущая доставка. */
  dashboard(userId: string): Promise<CourierDashboard | null>;
  /** Последняя доставка заказа — для отслеживания. */
  deliveryOfOrder(orderId: string): Promise<Delivery | null>;
  /** Кто шлёт координату и куда её разослать — одним запросом. */
  locationContext(userId: string): Promise<LocationContext | null>;
  listCouriers(): Promise<Courier[]>;
}

export const DELIVERY_REPOSITORY = Symbol("DeliveryRepository");

export class DuplicateDeliveryError extends Error {
  constructor(readonly orderId: string) {
    super(`по заказу ${orderId} уже есть действующая доставка`);
    this.name = "DuplicateDeliveryError";
  }
}
