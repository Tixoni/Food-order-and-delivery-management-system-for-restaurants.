import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { TooManyRequestsError, createLogger, type Logger } from "@food-delivery/shared";
import { ResilientRedisClient } from "@food-delivery/service-kit";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";

/**
 * Ограничение частоты попыток входа — требование SEC-5: не более десяти
 * попыток в минуту с одного адреса.
 *
 * Зачем это нужно именно на шлюзе, если у провайдера входа есть своя защита
 * от подбора: та защита блокирует учётную запись после неудачных попыток,
 * то есть срабатывает уже после того, как подбор начался, и по чужой воле
 * закрывает доступ настоящему владельцу. Ограничение по адресу отсекает
 * поток попыток раньше и не мешает владельцу войти с другого устройства.
 * Обе меры дополняют друг друга и обе включены.
 *
 * Счётчик хранится в Redis, а не в памяти процесса: при двух репликах шлюза
 * (SCAL-2) счётчик в памяти давал бы вдвое больший предел, а при перезапуске
 * обнулялся бы — подбор продолжился бы с чистого листа.
 */

/**
 * Окно и предел заданы требованием SEC-5. Регистрация и повторная отправка
 * письма считаются отдельно от входа: иначе неудачные попытки входа
 * мешали бы зарегистрироваться, — но с тем же пределом, чтобы через форму
 * нельзя было засыпать чужой ящик письмами.
 */
export type RateLimitScope = "login" | "register";

const WINDOW_SECONDS = 60;
const MAX_ATTEMPTS = 10;

@Injectable()
export class LoginRateLimiter implements OnApplicationShutdown {
  private readonly redis: ResilientRedisClient;
  private readonly logger: Logger;

  constructor(@Inject(GATEWAY_CONFIG) config: GatewayConfig) {
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "rate-limit",
    });

    this.redis = new ResilientRedisClient({
      host: config.redis.host,
      port: config.redis.port,
      commandTimeoutMs: 500,
      onError: (error) =>
        this.logger.warn("хранилище счётчиков недоступно", { error: error.message }),
    });
  }

  /**
   * Учитывает попытку входа и отказывает, когда предел исчерпан.
   *
   * Счётчик увеличивается до проверки пароля, а не после неудачи:
   * иначе подбор с верным паролем к чужой учётной записи не ограничивался бы
   * вовсе, а именно он и опасен.
   */
  async check(clientIp: string, scope: RateLimitScope = "login"): Promise<void> {
    const key = `auth:${scope}:${clientIp}`;
    const client = this.redis.readyClient;
    if (!client) {
      this.logger.warn("частота попыток входа не проверена: Redis недоступен");
      return;
    }

    let attempts: number;
    try {
      attempts = await client.incr(key);
      if (attempts === 1) {
        // Срок жизни ставится только при первой попытке: иначе окно
        // продлевалось бы с каждым обращением и предел стал бы вечным.
        await client.expire(key, WINDOW_SECONDS);
      }
    } catch (error) {
      // Отказ хранилища счётчиков не должен закрывать вход всем:
      // недоступность Redis — не повод останавливать работу системы.
      this.logger.warn("частота попыток входа не проверена", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (attempts > MAX_ATTEMPTS) {
      const retryAfter = await this.secondsLeft(key);

      this.logger.warn("превышена частота попыток", { clientIp, scope, attempts });
      const what = scope === "login" ? "попыток входа" : "запросов на регистрацию";
      throw new TooManyRequestsError(
        `слишком много ${what}: не более ${MAX_ATTEMPTS} в минуту. ` +
          `Повторите через ${retryAfter} с`,
        { retryAfterSeconds: retryAfter },
      );
    }
  }

  /** Сбрасывает счётчик после успешного входа: владелец не должен страдать. */
  async reset(clientIp: string): Promise<void> {
    await this.redis.readyClient?.del(`auth:login:${clientIp}`).catch(() => undefined);
  }

  private async secondsLeft(key: string): Promise<number> {
    const ttl = await this.redis.readyClient?.ttl(key).catch(() => WINDOW_SECONDS);
    if (ttl === undefined) return WINDOW_SECONDS;
    return ttl > 0 ? ttl : WINDOW_SECONDS;
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }
}
