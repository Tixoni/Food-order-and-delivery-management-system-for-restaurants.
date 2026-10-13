import { CircuitBreaker } from "@food-delivery/service-kit";
import { ExternalServiceError, type Logger } from "@food-delivery/shared";
import type { GeoPoint } from "../../domain/geo";
import type { Route, RoutePlanner } from "../../application/ports/route-planner";

export interface OsrmOptions {
  /** Адрес `osrm-routed`, например `http://osrm:5000`. */
  url: string;
  /** Сколько ждать ответа. Спайк: p95 маршрута 5,7 мс, матрицы на 10 точек — 6,1 мс. */
  timeoutMs: number;
  logger?: Logger;
  /** Подменяется в тестах. */
  fetch?: typeof fetch;
}

/** Ответы OSRM «дороги между точками нет» — штатные, а не отказ движка. */
const NO_ROUTE = new Set(["NoRoute", "NoSegment", "NoTable"]);

const coordinate = (point: GeoPoint) =>
  `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`;

/**
 * Маршрутизатор на OSRM (DLV-6) за размыкателем цепи (REL-2).
 *
 * Граф дорог — профиль «автомобиль»: велосипедные и пешеходные дорожки
 * в нём не учтены, поэтому для пешего и велосипедиста путь получается
 * немного длиннее настоящего. Для выбора между кандидатами и прогноза это
 * лучше прямой, а отдельные графы под каждый транспорт втрое увеличили бы
 * подготовку карты.
 *
 * Отказом считаются только сеть, таймаут и ответ 5xx. Три отказа подряд
 * размыкают цепь на 15 с: подбор в это время идёт по прямой и не ждёт
 * таймаута на каждом заказе.
 */
export class OsrmRoutePlanner implements RoutePlanner {
  private readonly breaker: CircuitBreaker;
  private readonly fetch: typeof fetch;
  private readonly url: string;

  constructor(private readonly options: OsrmOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.fetch = options.fetch ?? fetch;
    this.breaker = new CircuitBreaker({
      name: "osrm",
      failureThreshold: 3,
      openDurationMs: 15_000,
      onStateChange: (state) => {
        const message = `маршрутизатор: цепь ${state}`;
        if (state === "closed") options.logger?.info(message);
        else options.logger?.warn(message);
      },
    });
  }

  get circuitState() {
    return this.breaker.currentState;
  }

  async roadDistances(from: GeoPoint[], to: GeoPoint): Promise<(number | null)[]> {
    if (from.length === 0) return [];
    // Точка 0 — цель, остальные — источники: одна строка матрицы на курьера.
    const points = [to, ...from].map(coordinate).join(";");
    const sources = from.map((_, index) => index + 1).join(";");
    const body = await this.call<{ distances?: (number | null)[][] }>(
      `/table/v1/driving/${points}?sources=${sources}&destinations=0&annotations=distance`,
    );
    return from.map((_, index) => {
      const value = body?.distances?.[index]?.[0];
      return typeof value === "number" ? value : null;
    });
  }

  async route(from: GeoPoint, to: GeoPoint): Promise<Route | null> {
    const body = await this.call<{
      routes?: Array<{ distance: number; geometry: { coordinates: [number, number][] } }>;
    }>(
      `/route/v1/driving/${coordinate(from)};${coordinate(to)}` +
        `?overview=simplified&geometries=geojson&alternatives=false&steps=false`,
    );
    const found = body?.routes?.[0];
    if (!found) return null;
    const path = found.geometry.coordinates.map(([longitude, latitude]) => ({
      latitude,
      longitude,
    }));
    return { distanceMeters: Math.round(found.distance), path };
  }

  /** Ответ OSRM; `null` — дороги нет. */
  private call<T>(path: string): Promise<T | null> {
    return this.breaker.execute(
      async () => {
        let response: Response;
        try {
          response = await this.fetch(`${this.url}${path}`, {
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });
        } catch (error) {
          throw new ExternalServiceError("маршрутизатор не ответил", {
            dependency: "osrm",
            reason: error instanceof Error ? error.name : String(error),
          });
        }
        if (response.status >= 500) {
          throw new ExternalServiceError(`маршрутизатор ответил ${response.status}`, {
            dependency: "osrm",
          });
        }
        const body = (await response.json().catch(() => null)) as { code?: string } | null;
        if (body?.code === "Ok") return body as T;
        if (body?.code && NO_ROUTE.has(body.code)) return null;
        // Ошибка запроса — наша, а не движка: цепь из-за неё не размыкается.
        throw new Error(`маршрутизатор отклонил запрос: ${body?.code ?? response.status}`);
      },
      (error) => error instanceof ExternalServiceError,
    );
  }
}

/** Маршрутизатор не настроен (`OSRM_URL` пуст): всё по прямой. */
export class NoRoutePlanner implements RoutePlanner {
  async roadDistances(): Promise<(number | null)[]> {
    throw new ExternalServiceError("маршрутизатор не настроен", { dependency: "osrm" });
  }

  async route(): Promise<Route | null> {
    throw new ExternalServiceError("маршрутизатор не настроен", { dependency: "osrm" });
  }
}
