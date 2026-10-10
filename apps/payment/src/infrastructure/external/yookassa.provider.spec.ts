import { ExternalServiceError, TimeoutError, createLogger } from "@food-delivery/shared";
import { CircuitOpenError } from "@food-delivery/service-kit";
import { ProviderRejectedError } from "../../application/ports/payment-provider";
import { YooKassaProvider } from "./yookassa.provider";

const reply = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;

describe("YooKassaProvider", () => {
  let fetchMock: jest.Mock;

  const provider = (threshold = 5) =>
    new YooKassaProvider({
      baseUrl: "http://provider",
      shopId: "shop",
      secretKey: "secret",
      timeoutMs: 1000,
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      breaker: { failureThreshold: threshold, openDurationMs: 60_000 },
      logger: createLogger({ service: "test", level: "error" }),
      fetch: fetchMock as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });

  beforeEach(() => {
    fetchMock = jest.fn();
  });

  it("переводит копейки в рубли строкой и передаёт ключ идемпотентности", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "p-1", status: "waiting_for_capture" }));

    const result = await provider().hold({
      orderId: "o-1",
      amount: 39_050,
      currency: "RUB",
      idempotencyKey: "o-1:authorize",
    });

    expect(result).toEqual({ providerPaymentId: "p-1", held: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://provider/v3/payments");
    expect(init.headers["idempotence-key"]).toBe("o-1:authorize");
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from("shop:secret").toString("base64")}`,
    );
    expect(JSON.parse(init.body)).toMatchObject({
      amount: { value: "390.50", currency: "RUB" },
      capture: false,
    });
  });

  it("отказ банка — штатный исход с причиной", async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        id: "p-1",
        status: "canceled",
        cancellation_details: { reason: "insufficient_funds" },
      }),
    );

    await expect(
      provider().hold({ orderId: "o-1", amount: 100, currency: "RUB", idempotencyKey: "k" }),
    ).resolves.toEqual({
      providerPaymentId: "p-1",
      held: false,
      declineReason: "insufficient_funds",
    });
  });

  it("повторяет сбой 5xx с тем же ключом", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(500, {}))
      .mockResolvedValueOnce(reply(200, { id: "p-1", status: "succeeded" }));

    await provider().capture({ providerPaymentId: "p-1", amount: 100, idempotencyKey: "c-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers["idempotence-key"])).toEqual([
      "c-1",
      "c-1",
    ]);
  });

  it("отказ по существу (4xx) не повторяет и не размыкает цепь", async () => {
    fetchMock.mockResolvedValue(
      reply(400, { code: "invalid_request", description: "Payment is canceled" }),
    );
    const client = provider(1);

    await expect(
      client.capture({ providerPaymentId: "p-1", amount: 100, idempotencyKey: "c-1" }),
    ).rejects.toThrow(ProviderRejectedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.circuitState).toBe("closed");
  });

  it("таймаут — повторяемая ошибка", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));

    await expect(
      provider().cancel({ providerPaymentId: "p-1", idempotencyKey: "v-1" }),
    ).rejects.toThrow(TimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("после серии сбоев размыкает цепь и отказывает сразу, без сети", async () => {
    fetchMock.mockResolvedValue(reply(503, {}));
    const client = provider(3);

    await expect(
      client.refund({ providerPaymentId: "p-1", amount: 100, idempotencyKey: "r-1" }),
    ).rejects.toThrow(ExternalServiceError);
    const calls = fetchMock.mock.calls.length;

    await expect(
      client.refund({ providerPaymentId: "p-1", amount: 100, idempotencyKey: "r-1" }),
    ).rejects.toThrow(CircuitOpenError);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("не пишет в журнал ни тел запросов, ни тел ответов провайдера (SEC-3)", async () => {
    const lines: string[] = [];
    const client = new YooKassaProvider({
      baseUrl: "http://provider",
      shopId: "shop",
      secretKey: "secret-key-value",
      timeoutMs: 1000,
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      breaker: { failureThreshold: 5, openDurationMs: 60_000 },
      logger: createLogger({ service: "test", level: "debug", sink: (line) => lines.push(line) }),
      fetch: jest
        .fn()
        .mockResolvedValueOnce(reply(500, { description: "provider-internal-details" }))
        .mockResolvedValueOnce(
          reply(200, {
            id: "p-1",
            status: "waiting_for_capture",
            payment_method: { card: { last4: "4444", first6: "555555" } },
          }),
        ) as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });

    await client.hold({ orderId: "o-1", amount: 39_050, currency: "RUB", idempotencyKey: "k" });

    const journal = lines.join(" ");
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [
      "390.50",
      "4444",
      "555555",
      "provider-internal-details",
      "secret-key-value",
    ]) {
      expect(journal).not.toContain(secret);
    }
  });

  it("неверные учётные данные магазина — сбой настройки, а не отказ по существу", async () => {
    fetchMock.mockResolvedValue(reply(401, { code: "invalid_credentials" }));

    await expect(
      provider().capture({ providerPaymentId: "p-1", amount: 100, idempotencyKey: "c-1" }),
    ).rejects.toThrow(ExternalServiceError);
  });
});
