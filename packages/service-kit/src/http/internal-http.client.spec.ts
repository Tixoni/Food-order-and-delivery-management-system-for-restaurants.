import {
  DomainRuleError,
  ExternalServiceError,
  NotFoundError,
  TimeoutError,
  runWithContext,
} from "@food-delivery/shared";
import { CircuitOpenError } from "../resilience/circuit-breaker";
import { InternalHttpClient, appErrorFromResponse } from "./internal-http.client";

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;

describe("InternalHttpClient", () => {
  const sleep = () => Promise.resolve();
  let fetchMock: jest.Mock;

  const client = (overrides: Partial<ConstructorParameters<typeof InternalHttpClient>[0]> = {}) =>
    new InternalHttpClient({
      name: "catalog",
      baseUrl: "http://catalog:3001",
      timeoutMs: 1000,
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      breaker: { failureThreshold: 2, openDurationMs: 60_000 },
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      ...overrides,
    });

  beforeEach(() => {
    fetchMock = jest.fn();
  });

  it("передаёт сквозной идентификатор и токен пользователя", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));

    await runWithContext({ correlationId: "corr-1" }, () =>
      client().request({ method: "POST", path: "/x", token: "jwt", body: { a: 1 } }),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://catalog:3001/x");
    expect(init.headers).toMatchObject({
      "x-correlation-id": "corr-1",
      authorization: "Bearer jwt",
      "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("добавляет заголовки соседа, но не даёт подменить сквозной идентификатор", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));

    await runWithContext({ correlationId: "corr-2" }, () =>
      client({
        headers: { "x-internal-token": "secret", "x-correlation-id": "forged" },
      }).request({ method: "GET", path: "/x" }),
    );

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "x-internal-token": "secret",
      "x-correlation-id": "corr-2",
    });
  });

  it("повторяет чтение при отказе сети", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue(json(200, { items: [] }));

    await expect(client().request({ method: "GET", path: "/r" })).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("не повторяет изменяющий вызов без ключа идемпотентности", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(client().request({ method: "POST", path: "/p" })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("повторяет изменяющий вызов, помеченный идемпотентным", async () => {
    fetchMock.mockResolvedValueOnce(json(503, {})).mockResolvedValue(json(200, { id: 1 }));
    await expect(
      client().request({ method: "POST", path: "/p", idempotent: true }),
    ).resolves.toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("таймаут превращается в TimeoutError", async () => {
    const abort = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    fetchMock.mockRejectedValue(abort);
    await expect(
      client({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }).request({
        method: "GET",
        path: "/slow",
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("сохраняет смысл ответа соседа: «не найдено» остаётся «не найдено» и не повторяется", async () => {
    fetchMock.mockResolvedValue(json(404, { code: "NOT_FOUND", message: "ресторан не найден" }));
    await expect(client().request({ method: "GET", path: "/r/1" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("после порога отказов размыкает цепь и отвечает отказом без сетевого вызова", async () => {
    fetchMock.mockResolvedValue(json(500, { code: "INTERNAL" }));
    const c = client({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });

    await expect(c.request({ method: "GET", path: "/a" })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    await expect(c.request({ method: "GET", path: "/a" })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(c.circuitState).toBe("open");

    await expect(c.request({ method: "GET", path: "/a" })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("штатные ответы 4xx цепь не размыкают", async () => {
    fetchMock.mockResolvedValue(json(422, { code: "DOMAIN_RULE_VIOLATED", message: "закрыт" }));
    const c = client();
    for (let i = 0; i < 4; i += 1) {
      await expect(c.request({ method: "GET", path: "/a" })).rejects.toBeInstanceOf(
        DomainRuleError,
      );
    }
    expect(c.circuitState).toBe("closed");
  });

  it("незнакомый код и ответ 5xx считаются отказом зависимости", () => {
    expect(appErrorFromResponse("x", { code: "WHAT" }, 400, "/p")).toBeInstanceOf(
      ExternalServiceError,
    );
    expect(appErrorFromResponse("x", { code: "NOT_FOUND" }, 500, "/p")).toBeInstanceOf(
      ExternalServiceError,
    );
    expect(appErrorFromResponse("x", null, 502, "/p").details).toMatchObject({ status: 502 });
  });
});
