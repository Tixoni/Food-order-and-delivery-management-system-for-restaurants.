/**
 * Точка на карте.
 *
 * Отдельный тип вместо пары чисел — не украшательство. Широта и долгота
 * постоянно путаются местами: в географических типах базы принят порядок
 * «долгота, широта», в картографических библиотеках браузера — «широта,
 * долгота». Перепутанные координаты дают точку в другой стране,
 * и ошибка обнаруживается только по пустой выдаче.
 *
 * Здесь порядок задан именами полей, а не позицией в массиве.
 */

export class CoordinatesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatesError";
  }
}

export interface CoordinatesProps {
  latitude: number;
  longitude: number;
}

export class Coordinates {
  private constructor(
    readonly latitude: number,
    readonly longitude: number,
  ) {}

  static create(props: CoordinatesProps): Coordinates {
    const { latitude, longitude } = props;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new CoordinatesError("координаты должны быть числами");
    }
    if (latitude < -90 || latitude > 90) {
      throw new CoordinatesError(`широта вне допустимого диапазона: ${latitude}`);
    }
    if (longitude < -180 || longitude > 180) {
      throw new CoordinatesError(`долгота вне допустимого диапазона: ${longitude}`);
    }

    return new Coordinates(latitude, longitude);
  }

  /** Порядок «долгота, широта» — тот, который принят в географических типах базы. */
  toLonLat(): [number, number] {
    return [this.longitude, this.latitude];
  }

  equals(other: Coordinates): boolean {
    return this.latitude === other.latitude && this.longitude === other.longitude;
  }

  toString(): string {
    return `${this.latitude.toFixed(6)}, ${this.longitude.toFixed(6)}`;
  }
}
