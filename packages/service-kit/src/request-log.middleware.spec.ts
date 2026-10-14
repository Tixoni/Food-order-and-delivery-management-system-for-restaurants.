import { EventEmitter } from "node:events";
import { runWithContext } from "@food-delivery/shared";
import { MetricsService } from "./metrics.service";
import { RequestLogMiddleware, type LoggedRequest } from "./request-log.middleware";

function response(statusCode: number) {
  const emitter = new EventEmitter() as EventEmitter & { statusCode: number };
  emitter.statusCode = statusCode;
  return emitter;
}

describe("журнал запросов и показатели RED", () => {
  let lines: string[];
  let write: jest.SpyInstance;

  beforeEach(() => {
    lines = [];
    write = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  });
  afterEach(() => write.mockRestore());

  const records = () =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((r) => r.component === "http");

  it("одна запись на запрос: шаблон маршрута, код, длительность, идентификатор; без строки запроса", async () => {
    const metrics = new MetricsService("catalog");
    const middleware = new RequestLogMiddleware(metrics, "catalog");
    const request: LoggedRequest = {
      method: "GET",
      url: "/restaurants/delivery-to?lat=55.75&lon=37.61",
      route: { path: "/restaurants/delivery-to" },
    };
    const res = response(200);

    runWithContext({ correlationId: "corr-1" }, () =>
      middleware.use(request, res, () => undefined),
    );
    res.emit("finish");

    const [record] = records();
    expect(record).toMatchObject({
      level: "info",
      service: "catalog",
      route: "/restaurants/delivery-to",
      status: 200,
      correlationId: "corr-1",
    });
    expect(JSON.stringify(record)).not.toContain("55.75");
    const exported = await metrics.render();
    expect(exported).toMatch(
      /http_requests_total\{method="GET",route="\/restaurants\/delivery-to",status="200",service="catalog"\} 1/,
    );
    expect(exported).toContain("http_request_duration_seconds_count");
  });

  it("GraphQL — с именем операции; ошибка сервера — предупреждение; неизвестный путь — одна метка", async () => {
    const metrics = new MetricsService("gateway");
    const middleware = new RequestLogMiddleware(metrics, "gateway");
    const graphql = response(500);
    middleware.use(
      {
        method: "POST",
        url: "/graphql",
        body: { operationName: "PlaceOrder", variables: { phone: "1" } },
      },
      graphql,
      () => undefined,
    );
    graphql.emit("finish");
    const missing = response(404);
    middleware.use({ method: "GET", url: "/wp-admin/x" }, missing, () => undefined);
    missing.emit("finish");

    const [placed, unknown] = records();
    expect(placed).toMatchObject({ level: "warn", operation: "PlaceOrder", route: "/graphql" });
    expect(JSON.stringify(placed)).not.toContain("variables");
    expect(unknown.route).toBe("unmatched");
  });

  it("проверки живости и сбор метрик в журнал не идут", () => {
    const middleware = new RequestLogMiddleware(new MetricsService("order"), "order");
    const res = response(200);
    const next = jest.fn();
    middleware.use({ method: "GET", url: "/metrics" }, res, next);
    res.emit("finish");

    expect(next).toHaveBeenCalled();
    expect(records()).toHaveLength(0);
  });
});
