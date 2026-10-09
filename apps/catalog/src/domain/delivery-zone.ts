import { assertMoney, type Kopecks } from "./money";
import { Coordinates, CoordinatesError } from "./coordinates";

/**
 * Зона доставки ресторана — область на карте, внутри которой ресторан
 * берётся доставить заказ, вместе с условиями доставки именно для неё.
 *
 * Условия хранятся в зоне, а не только в ресторане: у одного ресторана
 * может быть ближняя зона с бесплатной доставкой и дальняя — с платной
 * и более высокой минимальной суммой. Значения ресторана служат образцом
 * при создании зоны, но дальше живут своей жизнью.
 *
 * Сам вопрос «попадает ли точка в зону» решает база: там для этого есть
 * пространственный индекс, и повторять эту проверку в коде означало бы
 * завести второй ответ на тот же вопрос. Здесь — правила, которым обязан
 * удовлетворять контур, нарисованный менеджером на карте (ADM-1).
 */

export class DeliveryZoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryZoneError";
  }
}

/** Замкнутый контур: последняя точка совпадает с первой. */
export type ZoneRing = Coordinates[];

export interface DeliveryZoneProps {
  id: string;
  restaurantId: string;
  name: string;
  /** Внешний контур области. Внутренние вырезы в прототипе не поддерживаются. */
  ring: ZoneRing;
  deliveryFee: Kopecks;
  minOrderAmount: Kopecks;
  isActive: boolean;
}

/** Минимум для многоугольника: три различные вершины плюс повтор первой. */
const MIN_RING_POINTS = 4;

/**
 * Верхний предел числа вершин. Ограничение не формальное: контур из тысяч
 * точек замедляет и проверку вхождения, и передачу зоны в браузер, а нарисовать
 * такой контур мышью невозможно — это признак ошибки, а не подробной зоны.
 */
const MAX_RING_POINTS = 500;
const MAX_NAME = 200;

export class DeliveryZone {
  private constructor(
    readonly id: string,
    readonly restaurantId: string,
    readonly name: string,
    readonly ring: readonly Coordinates[],
    readonly deliveryFee: Kopecks,
    readonly minOrderAmount: Kopecks,
    readonly isActive: boolean,
  ) {}

  static create(props: DeliveryZoneProps): DeliveryZone {
    if (props.id.trim().length === 0) {
      throw new DeliveryZoneError("идентификатор зоны не может быть пустым");
    }
    if (props.restaurantId.trim().length === 0) {
      throw new DeliveryZoneError("зона должна принадлежать ресторану");
    }

    const name = props.name.trim();
    if (name.length === 0) {
      throw new DeliveryZoneError("название зоны не может быть пустым");
    }
    if (name.length > MAX_NAME) {
      throw new DeliveryZoneError(`название зоны длиннее ${MAX_NAME} символов`);
    }

    assertMoney(props.deliveryFee, "стоимость доставки по зоне");
    assertMoney(props.minOrderAmount, "минимальная сумма заказа по зоне");

    const ring = DeliveryZone.normalizeRing(props.ring);

    return new DeliveryZone(
      props.id,
      props.restaurantId,
      name,
      Object.freeze([...ring]),
      props.deliveryFee,
      props.minOrderAmount,
      props.isActive,
    );
  }

  /**
   * Приведение контура к пригодному для хранения виду.
   *
   * Браузерный редактор карты отдаёт контур незамкнутым: пользователь
   * ставит вершины, а соединение последней с первой рисуется само.
   * База же требует замкнутый контур. Замыкаем здесь — один раз
   * и в одном месте, а не в каждом вызывающем коде.
   */
  private static normalizeRing(ring: ZoneRing): Coordinates[] {
    if (!Array.isArray(ring)) {
      throw new DeliveryZoneError("контур зоны должен быть списком точек");
    }

    const points = [...ring];
    const first = points[0];
    const last = points[points.length - 1];

    if (!first || !last) {
      throw new DeliveryZoneError("контур зоны не может быть пустым");
    }
    if (!first.equals(last)) {
      points.push(first);
    }

    if (points.length < MIN_RING_POINTS) {
      throw new DeliveryZoneError(
        "контур зоны должен содержать не менее трёх различных точек: " +
          "по двум точкам области не получится",
      );
    }
    if (points.length > MAX_RING_POINTS) {
      throw new DeliveryZoneError(`контур зоны длиннее ${MAX_RING_POINTS} точек`);
    }

    // Вершины, лежащие на одной прямой, дают область нулевой площади:
    // в неё не попадёт ни один адрес, и менеджер будет уверен, что доставка
    // настроена. Такую зону лучше отклонить сразу.
    if (DeliveryZone.doubleArea(points) === 0) {
      throw new DeliveryZoneError("контур зоны не ограничивает области: точки лежат на прямой");
    }

    return points;
  }

  /**
   * Удвоенная площадь контура по формуле площади многоугольника.
   * Нужна только для проверки на вырожденность, поэтому считается
   * в градусах и без перевода в метры.
   */
  private static doubleArea(points: readonly Coordinates[]): number {
    let sum = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const current = points[i];
      const next = points[i + 1];
      sum += current.longitude * next.latitude - next.longitude * current.latitude;
    }
    return Math.abs(sum);
  }

  /** Контур в виде, принятом в географических типах базы: «долгота, широта». */
  toLonLatRing(): [number, number][] {
    return this.ring.map((point) => point.toLonLat());
  }

  /** Зона, нарисованная менеджером заново: тот же идентификатор, новый контур. */
  withRing(ring: ZoneRing): DeliveryZone {
    return DeliveryZone.create({ ...this.toProps(), ring });
  }

  withConditions(conditions: { deliveryFee?: Kopecks; minOrderAmount?: Kopecks }): DeliveryZone {
    return DeliveryZone.create({
      ...this.toProps(),
      deliveryFee: conditions.deliveryFee ?? this.deliveryFee,
      minOrderAmount: conditions.minOrderAmount ?? this.minOrderAmount,
    });
  }

  deactivate(): DeliveryZone {
    return DeliveryZone.create({ ...this.toProps(), isActive: false });
  }

  toProps(): DeliveryZoneProps {
    return {
      id: this.id,
      restaurantId: this.restaurantId,
      name: this.name,
      ring: [...this.ring],
      deliveryFee: this.deliveryFee,
      minOrderAmount: this.minOrderAmount,
      isActive: this.isActive,
    };
  }
}

/** Разбор контура из запроса: список пар «широта, долгота». */
export function ringFromPairs(pairs: Array<{ latitude: number; longitude: number }>): ZoneRing {
  if (!Array.isArray(pairs)) {
    throw new CoordinatesError("контур зоны должен быть списком точек");
  }
  return pairs.map((pair) => Coordinates.create(pair));
}
