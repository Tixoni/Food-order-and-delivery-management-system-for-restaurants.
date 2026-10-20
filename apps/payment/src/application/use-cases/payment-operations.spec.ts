import { randomUUID } from "node:crypto";
import { PAYMENT_EVENT_TYPES } from "@food-delivery/contracts";
import {
  ConflictError,
  DomainRuleError,
  ExternalServiceError,
  ValidationError,
} from "@food-delivery/shared";
import { FakeProvider, InMemoryPaymentRepository } from "./in-memory.doubles";
import { PaymentOperationsUseCase } from "./payment-operations.use-case";

describe("PaymentOperationsUseCase", () => {
  let repository: InMemoryPaymentRepository;
  let provider: FakeProvider;
  let payments: PaymentOperationsUseCase;
  let orderId: string;
  const customerId = randomUUID();

  const authorize = (amount = 150_000, key = `${orderId}:authorize`) =>
    payments.authorize({ orderId, customerId, amount, currency: "RUB", idempotencyKey: key });

  beforeEach(() => {
    repository = new InMemoryPaymentRepository();
    provider = new FakeProvider();
    // В тестах операция «уже не выполняется» сразу: время не ждём.
    payments = new PaymentOperationsUseCase(repository, provider, { inFlightMs: 0 });
    orderId = randomUUID();
  });

  describe("холд (PAY-1)", () => {
    it("холдирует сумму и публикует PaymentAuthorized", async () => {
      const result = await authorize();

      expect(result.status).toBe("AUTHORIZED");
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.authorized)).toHaveLength(1);
      expect(repository.outbox[0].payload).toMatchObject({ orderId, amount: 150_000 });
    });

    it("отказ банка — штатный ответ DECLINED и событие PaymentFailed", async () => {
      provider.declineAbove = 100_000;

      const result = await authorize(150_000);

      expect(result).toMatchObject({ status: "DECLINED", declineReason: "insufficient_funds" });
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.failed)[0].payload).toMatchObject({
        operation: "AUTHORIZE",
      });
      // Повтор того же запроса получает тот же отказ, к банку не идёт.
      const calls = provider.calls;
      await expect(authorize(150_000)).resolves.toEqual(result);
      expect(provider.calls).toBe(calls);
    });
  });

  describe("идемпотентность (PAY-4)", () => {
    it("повтор с тем же ключом возвращает тот же ответ без обращения к провайдеру", async () => {
      const first = await authorize();
      const calls = provider.calls;

      await expect(authorize()).resolves.toEqual(first);
      expect(provider.calls).toBe(calls);
    });

    it("двадцать одновременных повторов — одно движение денег и одно событие", async () => {
      provider.delayMs = 5;

      const results = await Promise.all(Array.from({ length: 20 }, () => authorize()));

      expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
      expect(provider.moved.hold).toBe(1);
      expect(repository.payments.size).toBe(1);
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.authorized)).toHaveLength(1);
    });

    it("двадцать одновременных повторов списания — одно списание", async () => {
      await authorize();
      provider.delayMs = 5;
      const key = `${orderId}:capture`;

      await Promise.all(
        Array.from({ length: 20 }, () => payments.capture({ orderId, idempotencyKey: key })),
      );

      expect(provider.moved.capture).toBe(1);
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.captured)).toHaveLength(1);
    });

    it("тот же ключ для другой операции или суммы — конфликт, а не повтор", async () => {
      await authorize(150_000);
      await expect(authorize(99_000)).rejects.toThrow(ConflictError);
      await expect(
        payments.capture({ orderId, idempotencyKey: `${orderId}:authorize` }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe("списание, снятие холда и возврат (PAY-2, PAY-3, PAY-6)", () => {
    it("списывает захолдированное и возвращает частями до полной суммы", async () => {
      await authorize(150_000);
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).resolves.toMatchObject({
        status: "CAPTURED",
        amount: 150_000,
      });

      await expect(
        payments.refund({ orderId, idempotencyKey: "r-1", amount: 50_000 }),
      ).resolves.toMatchObject({ status: "PARTIALLY_REFUNDED", refundedTotal: 50_000 });
      await expect(
        payments.refund({ orderId, idempotencyKey: "r-2", amount: 100_000 }),
      ).resolves.toMatchObject({ status: "REFUNDED", refundedTotal: 150_000 });

      await expect(payments.refund({ orderId, idempotencyKey: "r-3", amount: 1 })).rejects.toThrow(
        DomainRuleError,
      );
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.refunded)).toHaveLength(2);
    });

    it("не списывает без холда и не снимает холд со списанного", async () => {
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        DomainRuleError,
      );

      await authorize();
      await payments.capture({ orderId, idempotencyKey: "c-1" });
      await expect(payments.void({ orderId, idempotencyKey: "v-1" })).rejects.toThrow(
        "нужен возврат",
      );
    });

    it("снятие холда без холда безопасно: voided=false", async () => {
      await expect(payments.void({ orderId, idempotencyKey: "v-0" })).resolves.toEqual({
        paymentId: null,
        voided: false,
      });

      await authorize();
      await expect(payments.void({ orderId, idempotencyKey: "v-1" })).resolves.toMatchObject({
        voided: true,
      });
      await expect(payments.void({ orderId, idempotencyKey: "v-2" })).resolves.toMatchObject({
        voided: false,
      });
      expect(provider.moved.cancel).toBe(1);
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.voided)).toHaveLength(1);
    });
  });

  describe("сбои провайдера", () => {
    it("сбой связи оставляет операцию незавершённой, повтор с тем же ключом её доводит", async () => {
      await authorize();
      provider.failNext = "before";

      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        ExternalServiceError,
      );
      expect([...repository.transactions.values()].at(-1)?.status).toBe("PENDING");

      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).resolves.toMatchObject({
        status: "CAPTURED",
      });
      expect(provider.moved.capture).toBe(1);
    });

    it("ответ потерян после списания — повтор не списывает второй раз", async () => {
      await authorize();
      provider.failNext = "after";

      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        ExternalServiceError,
      );
      await payments.capture({ orderId, idempotencyKey: "c-1" });

      expect(provider.moved.capture).toBe(1);
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.captured)).toHaveLength(1);
    });

    const pendingNow = () => repository.pending(0, 60_000, 10);
    const statusOfKey = (key: string) =>
      [...repository.transactions.values()].find((t) => t.idempotencyKey === key)?.status;

    it("сверка доводит холд, ответ на который был потерян", async () => {
      provider.failNext = "after";
      await expect(authorize()).rejects.toThrow(ExternalServiceError);

      const [pending] = await pendingNow();
      await expect(payments.reconcile(pending)).resolves.toBe(true);

      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.authorized)).toHaveLength(1);
      expect(provider.moved.hold).toBe(1);
    });

    it("сверка не выполняет брошенное списание — только узнаёт его итог", async () => {
      await authorize();
      provider.failOperation = "capture";
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        ExternalServiceError,
      );
      provider.failOperation = null;

      const [pending] = await pendingNow();
      await expect(payments.reconcile(pending)).resolves.toBe(false);

      expect(provider.moved.capture).toBe(0);
      expect(statusOfKey("c-1")).toBe("PENDING");
    });

    it("сверка фиксирует списание, которое прошло, хотя ответ потерян", async () => {
      await authorize();
      provider.failNext = "after";
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        ExternalServiceError,
      );

      const [pending] = await pendingNow();
      await expect(payments.reconcile(pending)).resolves.toBe(true);

      expect(statusOfKey("c-1")).toBe("SUCCEEDED");
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.captured)).toHaveLength(1);
      expect(provider.moved.capture).toBe(1);
    });

    it("два брошенных возврата: возврат провайдера засчитывается один раз", async () => {
      await authorize();
      await payments.capture({ orderId, idempotencyKey: "c-1" });
      provider.failNext = "after";
      await expect(
        payments.refund({ orderId, idempotencyKey: "r-1", amount: 50_000 }),
      ).rejects.toThrow(ExternalServiceError);
      // Второй возврат записан одновременным запросом и до провайдера не дошёл.
      await repository.startOperation(orderId, "r-2", "c", (p) => p.planRefund(50_000));

      // Обе операции сверяются с одним снимком платежа — как в одном проходе сверки.
      for (const pending of await pendingNow()) await payments.reconcile(pending);

      expect(statusOfKey("r-1")).toBe("SUCCEEDED");
      expect(statusOfKey("r-2")).toBe("PENDING");
      const [payment] = (await repository.history(orderId)).payments;
      expect(payment!.refundedAmount).toBe(50_000);
      expect(provider.moved.refund).toBe(1);
    });

    it("снятие холда закрывает брошенное списание, и деньги не списываются позже", async () => {
      await authorize();
      provider.failOperation = "capture";
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        ExternalServiceError,
      );

      // Оркестратор отказался от списания и снимает холд — отказ провайдера
      // на списаниях при этом не снят.
      await expect(payments.void({ orderId, idempotencyKey: "v-1" })).resolves.toMatchObject({
        voided: true,
      });
      expect(statusOfKey("c-1")).toBe("FAILED");
      expect(provider.moved).toMatchObject({ capture: 0, cancel: 1 });

      // Повтор брошенного списания тем же ключом уже ничего не спишет.
      provider.failOperation = null;
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        "заменена более новой",
      );
      expect(provider.moved.capture).toBe(0);
    });

    it("снятие холда после потерянного ответа на списание узнаёт, что деньги списаны", async () => {
      await authorize();
      provider.failNext = "after";
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        ExternalServiceError,
      );

      // Холд снять нельзя — нужен возврат; зато списание зафиксировано
      // и событие о нём ушло: оркестратор вернёт деньги, а не будет ждать.
      await expect(payments.void({ orderId, idempotencyKey: "v-1" })).rejects.toThrow(
        "нужен возврат",
      );
      expect(statusOfKey("c-1")).toBe("SUCCEEDED");
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.captured)).toHaveLength(1);
      await expect(
        payments.refund({ orderId, idempotencyKey: "r-1", amount: 150_000 }),
      ).resolves.toMatchObject({ status: "REFUNDED" });
    });

    it("младшую незавершённую операцию не закрывает: её ответ ещё может прийти", async () => {
      payments = new PaymentOperationsUseCase(repository, provider, { inFlightMs: 60_000 });
      await authorize();
      provider.failOperation = "capture";
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        ExternalServiceError,
      );

      await expect(payments.void({ orderId, idempotencyKey: "v-1" })).rejects.toThrow(
        "ещё выполняется",
      );
      expect(statusOfKey("c-1")).toBe("PENDING");
      expect(provider.moved.cancel).toBe(0);
    });

    it("отказ провайдера по существу — FAILED, PaymentFailed, повтор получает тот же отказ", async () => {
      await authorize();
      // Холд сняли напрямую у провайдера: списание он отклонит.
      for (const payment of provider.payments.values()) payment.status = "canceled";

      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        DomainRuleError,
      );
      const calls = provider.calls;
      await expect(payments.capture({ orderId, idempotencyKey: "c-1" })).rejects.toThrow(
        "провайдер отклонил операцию",
      );
      expect(provider.calls).toBe(calls);
      expect(repository.eventsOfType(PAYMENT_EVENT_TYPES.failed)[0].payload).toMatchObject({
        operation: "CAPTURE",
      });
    });
  });

  it.each([
    [{ orderId: "not-a-uuid" }, "orderId"],
    [{ idempotencyKey: "" }, "idempotencyKey"],
    [{ idempotencyKey: "k".repeat(101) }, "idempotencyKey"],
    [{ currency: "USD" }, "currency"],
    [{ amount: 0 }, "сумма"],
  ])("отклоняет неверный запрос %#", async (patch, message) => {
    const request = {
      orderId,
      customerId,
      amount: 1000,
      currency: "RUB" as const,
      idempotencyKey: "k-1",
      ...patch,
    };
    const failure = await payments.authorize(request as never).catch((error) => error);
    expect(failure).toBeInstanceOf(message === "сумма" ? DomainRuleError : ValidationError);
    expect(failure.message).toContain(message);
    expect(provider.calls).toBe(0);
  });
});
