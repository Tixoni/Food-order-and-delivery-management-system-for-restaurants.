import { extendContext, getContext, getCorrelationId, runWithContext } from "./context";

describe("контекст запроса", () => {
  it("виден из вложенных вызовов без передачи параметром", () => {
    const deep = () => getCorrelationId();
    const middle = () => deep();

    const result = runWithContext({ correlationId: "corr-1" }, () => middle());

    expect(result).toBe("corr-1");
  });

  it("переживает асинхронные паузы", async () => {
    const result = await runWithContext({ correlationId: "corr-2" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return getCorrelationId();
    });

    expect(result).toBe("corr-2");
  });

  it("не смешивает контексты параллельных действий", async () => {
    const run = (id: string, delay: number) =>
      runWithContext({ correlationId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return getCorrelationId();
      });

    const [first, second] = await Promise.all([run("corr-A", 20), run("corr-B", 5)]);

    expect(first).toBe("corr-A");
    expect(second).toBe("corr-B");
  });

  it("выдаёт новый идентификатор вне контекста — запись не остаётся без привязки", () => {
    expect(getContext()).toBeUndefined();
    expect(getCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("дополняет контекст, сохраняя уже имеющиеся поля", () => {
    const result = runWithContext({ correlationId: "corr-3" }, () =>
      extendContext({ userId: "user-1" }, () => getContext()),
    );

    expect(result).toEqual({ correlationId: "corr-3", userId: "user-1" });
  });
});
