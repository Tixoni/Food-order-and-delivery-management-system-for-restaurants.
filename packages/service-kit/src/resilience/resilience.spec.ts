import {
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  TimeoutError,
} from "@food-delivery/shared";
import { CircuitBreaker, CircuitOpenError, type CircuitState } from "./circuit-breaker";
import { backoffDelay, retry } from "./retry";

describe("CircuitBreaker", () => {
  let now = 0;
  let transitions: CircuitState[];
  let breaker: CircuitBreaker;
  const failing = () => Promise.reject(new ExternalServiceError("нет ответа"));

  beforeEach(() => {
    now = 0;
    transitions = [];
    breaker = new CircuitBreaker({
      name: "payment",
      failureThreshold: 3,
      openDurationMs: 1000,
      now: () => now,
      onStateChange: (state) => transitions.push(state),
    });
  });

  it("размыкается после порога отказов подряд и дальше отклоняет вызовы без сети", async () => {
    for (let i = 0; i < 3; i += 1) await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.currentState).toBe("open");

    const call = jest.fn().mockResolvedValue("ok");
    await expect(breaker.execute(call)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(call).not.toHaveBeenCalled();
  });

  it("успешный вызов обнуляет счётчик: отказы не накапливаются через успехи", async () => {
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();
    await breaker.execute(() => Promise.resolve(1));
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.currentState).toBe("closed");
  });

  it("после паузы пропускает один пробный вызов; успех замыкает цепь", async () => {
    for (let i = 0; i < 3; i += 1) await expect(breaker.execute(failing)).rejects.toThrow();
    now = 1000;
    expect(breaker.currentState).toBe("half-open");

    await expect(breaker.execute(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(breaker.currentState).toBe("closed");
    expect(transitions).toEqual(["open", "half-open", "closed"]);
  });

  it("отказ пробного вызова снова размыкает цепь на полную паузу", async () => {
    for (let i = 0; i < 3; i += 1) await expect(breaker.execute(failing)).rejects.toThrow();
    now = 1000;
    await expect(breaker.execute(failing)).rejects.toThrow(ExternalServiceError);
    expect(breaker.currentState).toBe("open");
    now = 1999;
    expect(breaker.currentState).toBe("open");
  });

  it("пока идёт пробный вызов, остальные отклоняются", async () => {
    for (let i = 0; i < 3; i += 1) await expect(breaker.execute(failing)).rejects.toThrow();
    now = 1000;
    let release!: () => void;
    const probe = breaker.execute(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(breaker.execute(() => Promise.resolve())).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await probe;
    expect(breaker.currentState).toBe("closed");
  });

  it("штатный ответ «не найдено» цепь не размыкает", async () => {
    const notFound = () => Promise.reject(new NotFoundError("нет такого"));
    const isFailure = (error: unknown) => !(error instanceof NotFoundError);
    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.execute(notFound, isFailure)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(breaker.currentState).toBe("closed");
  });

  it("не принимает порог меньше единицы", () => {
    expect(
      () => new CircuitBreaker({ name: "x", failureThreshold: 0, openDurationMs: 1 }),
    ).toThrow();
  });
});

describe("retry", () => {
  const noSleep = jest.fn(() => Promise.resolve());

  beforeEach(() => noSleep.mockClear());

  it("повторяет повторяемую ошибку и возвращает первый успех", async () => {
    const call = jest
      .fn()
      .mockRejectedValueOnce(new TimeoutError("медленно"))
      .mockRejectedValueOnce(new ExternalServiceError("сбой"))
      .mockResolvedValue("ok");

    await expect(
      retry(call, { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep }),
    ).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it("не повторяет ошибку, повтор которой бессмыслен", async () => {
    const call = jest.fn().mockRejectedValue(new ConflictError("уже есть"));
    await expect(
      retry(call, { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("после исчерпания попыток отдаёт последнюю ошибку", async () => {
    const call = jest.fn().mockRejectedValue(new ExternalServiceError("лежит"));
    await expect(
      retry(call, { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep }),
    ).rejects.toThrow("лежит");
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("задержка растёт экспоненциально и упирается в потолок", () => {
    const max = () => 1;
    expect(backoffDelay(1, 100, 1000, max)).toBe(100);
    expect(backoffDelay(2, 100, 1000, max)).toBe(200);
    expect(backoffDelay(3, 100, 1000, max)).toBe(400);
    expect(backoffDelay(10, 100, 1000, max)).toBe(1000);
  });

  it("разброс держит задержку между половиной и полным значением", () => {
    expect(backoffDelay(3, 100, 1000, () => 0)).toBe(200);
    expect(backoffDelay(3, 100, 1000, () => 0.5)).toBe(300);
  });
});
