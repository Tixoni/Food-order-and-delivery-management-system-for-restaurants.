import { CheckoutSaga } from "./checkout-saga";

describe("сага оформления: что осталось компенсировать", () => {
  it("до холда компенсировать нечего", () => {
    const saga = CheckoutSaga.start("s-1", "o-1", "corr");
    expect(saga.pendingCompensations()).toEqual({ void: false, refund: 0, releaseCourier: false });
    expect(saga.fullyCompensated).toBe(true);
  });

  it("холд без списания — нужно снять холд", () => {
    const saga = CheckoutSaga.start("s-1", "o-1", "corr");
    saga.record({ paymentAuthorized: true });
    expect(saga.pendingCompensations().void).toBe(true);
    saga.record({ paymentVoided: true });
    expect(saga.fullyCompensated).toBe(true);
  });

  it("неизвестный исход холда — снять «на всякий случай»", () => {
    const saga = CheckoutSaga.start("s-1", "o-1", "corr");
    saga.record({ defensiveVoidPending: true });
    expect(saga.pendingCompensations().void).toBe(true);
  });

  it("после списания — возврат: полный или до указанной оператором суммы", () => {
    const saga = CheckoutSaga.start("s-1", "o-1", "corr");
    saga.record({ paymentAuthorized: true, paymentCaptured: true, capturedAmount: 100000 });
    expect(saga.pendingCompensations()).toMatchObject({ void: false, refund: 100000 });

    saga.record({ refundTarget: 30000 });
    expect(saga.pendingCompensations().refund).toBe(30000);
    saga.record({ refundedAmount: 30000 });
    expect(saga.pendingCompensations().refund).toBe(0);

    // Сумма возврата не больше списанного, даже если цель указана больше.
    saga.record({ refundTarget: 500000, refundedAmount: 0 });
    expect(saga.pendingCompensations().refund).toBe(100000);
  });

  it("вызванного курьера нужно освободить", () => {
    const saga = CheckoutSaga.start("s-1", "o-1", "corr");
    saga.record({ courierRequested: true });
    expect(saga.pendingCompensations().releaseCourier).toBe(true);
    saga.record({ courierReleased: true });
    expect(saga.fullyCompensated).toBe(true);
  });

  it("каждая новая компенсация получает новый номер для ключа идемпотентности", () => {
    const saga = CheckoutSaga.start("s-1", "o-1", "corr");
    expect(saga.nextSeq("voidSeq")).toBe(1);
    expect(saga.nextSeq("voidSeq")).toBe(2);
    expect(saga.facts.voidSeq).toBe(2);
  });

  it("жизненный цикл статуса: выполняется → компенсируется → завершена отменой", () => {
    const saga = CheckoutSaga.start("s-1", "o-1", "corr");
    expect(saga.status).toBe("RUNNING");
    saga.compensate();
    expect(saga.status).toBe("COMPENSATING");
    saga.finishCompensation();
    expect(saga.status).toBe("FAILED");
    const delivered = CheckoutSaga.start("s-2", "o-2", "corr");
    delivered.complete();
    expect(delivered.status).toBe("COMPLETED");
  });

  it("восстановление из хранилища дополняет факты, которых не было в старой записи", () => {
    const saga = CheckoutSaga.restore({
      id: "s",
      orderId: "o",
      correlationId: "corr",
      status: "RUNNING",
      currentStep: "X",
      facts: { paymentAuthorized: true } as never,
      version: 3,
    });
    expect(saga.facts).toMatchObject({
      paymentAuthorized: true,
      voidSeq: 0,
      courierRequested: false,
    });
  });
});
