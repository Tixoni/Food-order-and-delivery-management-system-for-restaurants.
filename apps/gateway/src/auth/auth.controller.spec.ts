import { TooManyRequestsError, UnauthorizedError, ValidationError } from "@food-delivery/shared";
import { AuthController } from "./auth.controller";

describe("вход: ограничение частоты по адресу (SEC-5)", () => {
  it("успешный вход в свою учётную запись не обнуляет предел для адреса", async () => {
    let attempts = 0;
    const rateLimiter = {
      check: async () => {
        attempts += 1;
        if (attempts > 10) throw new TooManyRequestsError("слишком много попыток входа");
      },
    };
    const keycloak = {
      login: async (username: string) => {
        if (username !== "own") throw new UnauthorizedError("неверное имя пользователя или пароль");
        return { accessToken: "a", refreshToken: "r", expiresIn: 900, tokenType: "Bearer" };
      },
    };
    const verifier = { verify: async () => ({ id: "u-1", roles: [] }) };
    const controller = new AuthController(
      keycloak as never,
      rateLimiter as never,
      verifier as never,
      {} as never,
    );
    const request = { headers: {}, ip: "203.0.113.7" };
    const response = { cookie: () => undefined, setHeader: () => undefined };
    const login = (username: string) =>
      controller.login({ username, password: "secret" }, request, response);

    for (let i = 0; i < 9; i += 1) {
      await expect(login("victim")).rejects.toThrow(UnauthorizedError);
    }
    await login("own");

    await expect(login("victim")).rejects.toThrow(TooManyRequestsError);
  });
});

describe("продление сеанса", () => {
  it("испорченная кука — «войдите заново», а не внутренняя ошибка", async () => {
    const controller = new AuthController({} as never, {} as never, {} as never, {} as never);
    const request = { headers: { cookie: "fd_refresh=%E0%A4%A" } };
    const response = { setHeader: () => undefined };

    await expect(controller.refresh(request, response)).rejects.toThrow(ValidationError);
  });
});
