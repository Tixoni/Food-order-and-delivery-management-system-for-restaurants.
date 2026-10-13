import { ExternalServiceError } from "@food-delivery/shared";
import { CircuitOpenError } from "@food-delivery/service-kit";
import { OsrmRoutePlanner } from "./osrm-route-planner";

const RESTAURANT = { latitude: 55.75, longitude: 37.6 };
const A = { latitude: 55.751, longitude: 37.601 };
const B = { latitude: 55.76, longitude: 37.62 };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function planner(respond: (url: string, init?: RequestInit) => Promise<Response>) {
  const urls: string[] = [];
  const fake = jest.fn((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return respond(String(input), init);
  });
  const instance = new OsrmRoutePlanner({
    url: "http://osrm:5000/",
    timeoutMs: 50,
    fetch: fake as unknown as typeof fetch,
  });
  return { instance, urls, fake };
}

describe("маршрутизатор OSRM", () => {
  it("матрица: цель — точка 0, курьеры — источники; нет дороги — null", async () => {
    const { instance, urls } = planner(() => json({ code: "Ok", distances: [[1200.4], [null]] }));

    const distances = await instance.roadDistances([A, B], RESTAURANT);

    expect(distances).toEqual([1200.4, null]);
    expect(urls[0]).toBe(
      "http://osrm:5000/table/v1/driving/37.600000,55.750000;37.601000,55.751000;37.620000,55.760000" +
        "?sources=1;2&destinations=0&annotations=distance",
    );
  });

  it("маршрут: линия GeoJSON становится точками, длина округляется", async () => {
    const { instance } = planner(() =>
      json({
        code: "Ok",
        routes: [
          {
            distance: 2345.6,
            geometry: {
              coordinates: [
                [37.6, 55.75],
                [37.61, 55.755],
                [37.62, 55.76],
              ],
            },
          },
        ],
      }),
    );

    const route = await instance.route(RESTAURANT, B);

    expect(route?.distanceMeters).toBe(2346);
    expect(route?.path[1]).toEqual({ latitude: 55.755, longitude: 37.61 });
  });

  it("«дороги нет» — штатный ответ: null, и цепь от него не размыкается", async () => {
    const { instance } = planner(() => json({ code: "NoRoute" }, 400));

    for (let i = 0; i < 5; i += 1) await expect(instance.route(A, B)).resolves.toBeNull();
    expect(instance.circuitState).toBe("closed");
  });

  it("три отказа подряд размыкают цепь — дальше отказ сразу, без сети", async () => {
    const { instance, fake } = planner(() => Promise.reject(new TypeError("fetch failed")));

    for (let i = 0; i < 3; i += 1) {
      await expect(instance.route(A, B)).rejects.toBeInstanceOf(ExternalServiceError);
    }
    await expect(instance.roadDistances([A], RESTAURANT)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fake).toHaveBeenCalledTimes(3);
    expect(instance.circuitState).toBe("open");
  });

  it("не ответил в срок — отказ, а не ожидание", async () => {
    const { instance } = planner(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );

    const started = Date.now();
    await expect(instance.route(A, B)).rejects.toBeInstanceOf(ExternalServiceError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("ответ 5xx — отказ движка", async () => {
    const { instance } = planner(() => json({ message: "boom" }, 503));

    await expect(instance.route(A, B)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
