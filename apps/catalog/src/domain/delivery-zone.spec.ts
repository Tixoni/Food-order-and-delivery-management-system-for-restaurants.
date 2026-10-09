import { Coordinates, CoordinatesError } from "./coordinates";
import { DeliveryZone, DeliveryZoneError, ringFromPairs } from "./delivery-zone";
import { MoneyError } from "./money";

const at = (latitude: number, longitude: number) => Coordinates.create({ latitude, longitude });

/** Квадрат вокруг центра Москвы, незамкнутый — как его отдаёт редактор карты. */
const square = () => [at(55.75, 37.6), at(55.75, 37.65), at(55.78, 37.65), at(55.78, 37.6)];

const zone = (overrides: Partial<Parameters<typeof DeliveryZone.create>[0]> = {}) =>
  DeliveryZone.create({
    id: "z-1",
    restaurantId: "r-1",
    name: "Основная зона",
    ring: square(),
    deliveryFee: 14900,
    minOrderAmount: 50000,
    isActive: true,
    ...overrides,
  });

describe("Coordinates", () => {
  it("хранит широту и долготу под своими именами", () => {
    const point = at(55.75, 37.6);

    expect(point.latitude).toBe(55.75);
    expect(point.longitude).toBe(37.6);
  });

  it("отдаёт пару в порядке, принятом в базе: долгота, широта", () => {
    expect(at(55.75, 37.6).toLonLat()).toEqual([37.6, 55.75]);
  });

  it("отвергает широту вне диапазона — признак перепутанных координат", () => {
    // 37.6 как широта допустимо, а 55.75 как долгота — тоже; поймать
    // перестановку можно только на значениях больше 90
    expect(() => at(95, 37.6)).toThrow(CoordinatesError);
    expect(() => at(55.75, 200)).toThrow(CoordinatesError);
  });

  it("отвергает нечисловые значения", () => {
    expect(() => at(Number.NaN, 37.6)).toThrow(CoordinatesError);
    expect(() => at(55.75, Number.POSITIVE_INFINITY)).toThrow(CoordinatesError);
  });

  it("сравнивает точки по значению, а не по ссылке", () => {
    expect(at(55.75, 37.6).equals(at(55.75, 37.6))).toBe(true);
    expect(at(55.75, 37.6).equals(at(55.76, 37.6))).toBe(false);
  });
});

describe("DeliveryZone", () => {
  it("замыкает контур, пришедший из редактора карты незамкнутым", () => {
    const ring = zone().ring;

    expect(ring).toHaveLength(5);
    expect(ring[0].equals(ring[4])).toBe(true);
  });

  it("не замыкает контур повторно, если он уже замкнут", () => {
    const closed = [...square(), at(55.75, 37.6)];

    expect(zone({ ring: closed }).ring).toHaveLength(5);
  });

  it("отвергает контур из двух точек: области по ним не построить", () => {
    expect(() => zone({ ring: [at(55.75, 37.6), at(55.78, 37.65)] })).toThrow(DeliveryZoneError);
  });

  it("отвергает пустой контур", () => {
    expect(() => zone({ ring: [] })).toThrow(DeliveryZoneError);
  });

  it("отвергает вырожденный контур: точки на одной прямой", () => {
    expect(() => zone({ ring: [at(55.75, 37.6), at(55.76, 37.6), at(55.77, 37.6)] })).toThrow(
      /не ограничивает области/,
    );
  });

  it("отвергает слишком подробный контур", () => {
    const many = Array.from({ length: 501 }, (_, i) => at(55.75 + i * 0.0001, 37.6 + i * 0.0002));

    expect(() => zone({ ring: many })).toThrow(/длиннее 500 точек/);
  });

  it("отвергает отрицательные деньги", () => {
    expect(() => zone({ deliveryFee: -100 })).toThrow(MoneyError);
    expect(() => zone({ minOrderAmount: -1 })).toThrow(MoneyError);
  });

  it("отвергает дробные копейки", () => {
    expect(() => zone({ deliveryFee: 149.5 })).toThrow(MoneyError);
  });

  it("требует название и принадлежность ресторану", () => {
    expect(() => zone({ name: "   " })).toThrow(DeliveryZoneError);
    expect(() => zone({ restaurantId: "" })).toThrow(DeliveryZoneError);
  });

  it("отдаёт контур в порядке «долгота, широта» для базы", () => {
    expect(zone().toLonLatRing()[0]).toEqual([37.6, 55.75]);
  });

  it("перерисовка контура не меняет исходную зону", () => {
    const original = zone();
    const redrawn = original.withRing([at(55.7, 37.5), at(55.7, 37.55), at(55.72, 37.55)]);

    expect(redrawn.ring).toHaveLength(4);
    expect(original.ring).toHaveLength(5);
    expect(redrawn.id).toBe(original.id);
  });

  it("условия доставки меняются по отдельности", () => {
    const updated = zone().withConditions({ deliveryFee: 0 });

    expect(updated.deliveryFee).toBe(0);
    expect(updated.minOrderAmount).toBe(50000);
  });

  it("отключение зоны не удаляет её", () => {
    const disabled = zone().deactivate();

    expect(disabled.isActive).toBe(false);
    expect(disabled.ring).toHaveLength(5);
  });

  it("собирает контур из пар, пришедших в запросе", () => {
    const ring = ringFromPairs([
      { latitude: 55.75, longitude: 37.6 },
      { latitude: 55.75, longitude: 37.65 },
      { latitude: 55.78, longitude: 37.65 },
    ]);

    expect(ring).toHaveLength(3);
    expect(ring[0].latitude).toBe(55.75);
  });

  it("сообщает о неверной точке в контуре из запроса", () => {
    expect(() => ringFromPairs([{ latitude: 200, longitude: 37.6 }])).toThrow(CoordinatesError);
  });
});
