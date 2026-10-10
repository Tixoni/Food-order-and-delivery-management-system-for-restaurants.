import { ProviderEmulator, type EmulatorRequest } from "./emulator";

const credentials = { shopId: "shop", secretKey: "secret" };
const auth = `Basic ${Buffer.from("shop:secret").toString("base64")}`;

describe("ProviderEmulator", () => {
  let emulator: ProviderEmulator;

  const call = (
    method: string,
    path: string,
    body?: unknown,
    key: string | undefined = `key-${Math.random()}`,
  ) =>
    emulator.handle({
      method,
      path,
      headers: { authorization: auth, ...(key ? { "idempotence-key": key } : {}) },
      body,
    } as EmulatorRequest);

  const hold = (value = "1500.00", key?: string) =>
    call(
      "POST",
      "/v3/payments",
      { amount: { value, currency: "RUB" }, capture: false, metadata: { orderId: "o-1" } },
      key,
    );

  const idOf = (response: { body: unknown }) => (response.body as { id: string }).id;

  beforeEach(() => {
    emulator = new ProviderEmulator(
      credentials,
      {},
      () => 1,
      async () => undefined,
    );
  });

  it("проводит холд, списание и частичные возвраты в рублях строкой", async () => {
    const created = await hold("1500.00");
    expect(created.body).toMatchObject({ status: "waiting_for_capture", paid: true });

    const id = idOf(created);
    await expect(call("POST", `/v3/payments/${id}/capture`)).resolves.toMatchObject({
      status: 200,
      body: { status: "succeeded" },
    });

    const refund = (value: string) =>
      call("POST", "/v3/refunds", { payment_id: id, amount: { value, currency: "RUB" } });
    await expect(refund("500.00")).resolves.toMatchObject({ status: 200 });
    await expect(refund("1000.01")).resolves.toMatchObject({ status: 400 });
    await expect(refund("1000.00")).resolves.toMatchObject({ status: 200 });
  });

  it("повтор с тем же ключом — тот же ответ, деньги не двигаются второй раз", async () => {
    const first = await hold("100.00", "same");
    const second = await hold("100.00", "same");

    expect(idOf(second)).toBe(idOf(first));
    const stats = await emulator.handle({
      method: "GET",
      path: "/_emulator/stats",
      headers: {},
      body: null,
    });
    expect(stats.body).toMatchObject({ performed: { create: 1 }, payments: 1 });
  });

  it("держит автомат платежа: не списывает отменённый и не отменяет списанный", async () => {
    const id = idOf(await hold());
    await call("POST", `/v3/payments/${id}/cancel`);
    await expect(call("POST", `/v3/payments/${id}/capture`)).resolves.toMatchObject({
      status: 400,
    });

    const other = idOf(await hold());
    await call("POST", `/v3/payments/${other}/capture`);
    await expect(call("POST", `/v3/payments/${other}/cancel`)).resolves.toMatchObject({
      status: 400,
    });
  });

  it("отклоняет холд дороже порога как банк — платёж canceled", async () => {
    emulator.settings.declineAbove = 100_000;
    await expect(hold("1000.01")).resolves.toMatchObject({
      status: 200,
      body: { status: "canceled", cancellation_details: { reason: "insufficient_funds" } },
    });
  });

  it("отказ до выполнения не сохраняется — повтор с тем же ключом проходит", async () => {
    emulator.settings.failOperation = "create";
    await expect(hold("100.00", "k")).resolves.toMatchObject({ status: 500 });

    emulator.settings.failOperation = null;
    await expect(hold("100.00", "k")).resolves.toMatchObject({ status: 200 });
  });

  it("потерянный ответ: операция выполнена, повтор получает её результат", async () => {
    const id = idOf(await hold());
    emulator.settings.loseResponseOperation = "capture";
    await expect(call("POST", `/v3/payments/${id}/capture`, undefined, "c")).resolves.toMatchObject(
      {
        status: 500,
      },
    );

    emulator.settings.loseResponseOperation = null;
    await expect(call("POST", `/v3/payments/${id}/capture`, undefined, "c")).resolves.toMatchObject(
      {
        status: 200,
        body: { status: "succeeded" },
      },
    );
    const stats = await emulator.handle({
      method: "GET",
      path: "/_emulator/stats",
      headers: {},
      body: null,
    });
    expect(stats.body).toMatchObject({ performed: { capture: 1 } });
  });

  it("требует ключ идемпотентности и учётные данные магазина", async () => {
    await expect(hold("100.00", "")).resolves.toMatchObject({ status: 400 });
    await expect(
      emulator.handle({ method: "POST", path: "/v3/payments", headers: {}, body: {} }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("меняет режимы на лету и проверяет их", async () => {
    const control = (body: unknown) =>
      emulator.handle({ method: "POST", path: "/_emulator/settings", headers: {}, body });

    await expect(control({ failOperation: "capture", delayMs: 10 })).resolves.toMatchObject({
      status: 200,
      body: { failOperation: "capture", delayMs: 10 },
    });
    await expect(control({ failOperation: "everything" })).resolves.toMatchObject({ status: 400 });
    await expect(control({ failureRate: 2 })).resolves.toMatchObject({ status: 400 });
  });
});
