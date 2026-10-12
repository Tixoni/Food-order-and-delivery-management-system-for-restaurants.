import { Courier, type CourierState } from "./courier";
import { Delivery, Offer } from "./delivery";
import { DeliveryConflictError, DeliveryRuleError } from "./delivery-errors";
import { distanceMeters, etaMinutes, geoPoint } from "./geo";

const now = new Date("2026-10-12T12:00:00Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);

const courier = (overrides: Partial<CourierState> = {}) =>
  Courier.restore({
    id: "c-1",
    userId: "u-1",
    fullName: "Курьер",
    phone: null,
    vehicleType: "bike",
    status: "offline",
    currentDeliveryId: null,
    isActive: true,
    lastLocation: null,
    lastLocationAt: null,
    ...overrides,
  });

const delivery = () =>
  Delivery.open({
    id: "d-1",
    orderId: "o-1",
    restaurantId: "r-1",
    customerId: "cust-1",
    pickup: geoPoint(55.75, 37.6),
    dropoff: geoPoint(55.76, 37.62),
    readyAt: null,
    requestKey: "o-1:courier:1",
    correlationId: null,
    now,
  });

describe("Courier", () => {
  it("смена → предложение → принял → доставил → снова свободен", () => {
    const c = courier();
    expect(c.startShift()).toBe(true);
    c.offer();
    expect(c.status).toBe("assigned");
    c.accept("d-1");
    expect(c.snapshot).toMatchObject({ status: "busy", currentDeliveryId: "d-1" });
    c.free();
    expect(c.snapshot).toMatchObject({ status: "available", currentDeliveryId: null });
  });

  it("без учётной записи и отключённый на смену не выходит", () => {
    expect(() => courier({ userId: null }).startShift()).toThrow(DeliveryRuleError);
    expect(() => courier({ isActive: false }).startShift()).toThrow("отключён");
  });

  it("с заказом на руках со смены не уходит; занятому не предлагают второй заказ", () => {
    const c = courier({ status: "busy" });
    expect(() => c.endShift()).toThrow("завершите доставку");
    expect(() => c.offer()).toThrow(DeliveryRuleError);
  });

  it("отказ или молчание возвращают в подбор", () => {
    const c = courier({ status: "assigned" });
    c.declineOffer();
    expect(c.status).toBe("available");
  });
});

describe("Delivery", () => {
  it("принят → забрал → вручил", () => {
    const d = delivery();
    d.accept("c-1", now);
    expect(d.pickUp("c-1", later(60))).toBe(true);
    expect(d.complete("c-1", later(600))).toBe(true);
    expect(d.snapshot).toMatchObject({ status: "DELIVERED", courierId: "c-1" });
    // Повтор отметки — без ошибки и без изменений
    expect(d.complete("c-1", later(700))).toBe(false);
  });

  it("«доставил» до «забрал» невозможно (DLV-5)", () => {
    const d = delivery();
    d.accept("c-1", now);
    expect(() => d.complete("c-1", now)).toThrow("сначала отметьте");
  });

  it("второй курьер не может принять уже принятый заказ и отмечать чужую доставку", () => {
    const d = delivery();
    d.accept("c-1", now);
    expect(() => d.accept("c-2", now)).toThrow(DeliveryConflictError);
    expect(() => d.pickUp("c-2", now)).toThrow("другому курьеру");
  });

  it("отмена до вручения; вручённый не отменяется", () => {
    const pending = delivery();
    expect(pending.cancel(now)).toBe(true);
    expect(pending.status).toBe("CANCELLED");

    const done = delivery();
    done.accept("c-1", now);
    done.pickUp("c-1", now);
    done.complete("c-1", now);
    expect(done.cancel(now)).toBe(false);
  });
});

describe("Offer (DLV-4)", () => {
  const offer = () =>
    Offer.make({
      id: "of-1",
      deliveryId: "d-1",
      courierId: "c-1",
      sequence: 1,
      now,
      ttlSeconds: 90,
    });

  it("курьер принимает в срок", () => {
    const o = offer();
    o.respond("c-1", "ACCEPTED", later(30));
    expect(o.snapshot.response).toBe("ACCEPTED");
  });

  it("просроченное принять нельзя — заказ уже ушёл следующему", () => {
    expect(() => offer().respond("c-1", "ACCEPTED", later(90))).toThrow("просрочено");
  });

  it("чужое и закрытое предложение — конфликт", () => {
    const o = offer();
    expect(() => o.respond("c-2", "ACCEPTED", later(1))).toThrow("другому курьеру");
    o.expire(later(91));
    expect(o.snapshot.response).toBe("TIMEOUT");
    expect(() => o.respond("c-1", "REJECTED", later(92))).toThrow("уже закрыто");
  });
});

describe("geo", () => {
  it("считает расстояние и время в пути", () => {
    const a = geoPoint(55.7558, 37.6176);
    const b = geoPoint(55.7658, 37.6176);
    expect(Math.round(distanceMeters(a, b))).toBe(1112);
    expect(etaMinutes(a, b, "bike")).toBe(7);
    expect(etaMinutes(a, a, "foot")).toBe(1);
  });

  it.each([
    [91, 0],
    [0, 181],
    [Number.NaN, 0],
  ])("отклоняет координаты %p, %p", (lat, lon) => {
    expect(() => geoPoint(lat, lon)).toThrow(DeliveryRuleError);
  });
});
