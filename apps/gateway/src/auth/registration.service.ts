import { Inject, Injectable } from "@nestjs/common";
import { ValidationError, createLogger, type Logger } from "@food-delivery/shared";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";
import { ACCOUNT_DIRECTORY, type AccountDirectory } from "./keycloak-admin.client";

/**
 * Регистрация клиента с подтверждением e-mail (AUTH-1).
 *
 * Ответ одинаков, занят адрес или свободен: «письмо отправлено». Иначе
 * форма регистрации отвечала бы на вопрос «есть ли у сервиса клиент
 * с таким адресом» — тот же перебор учётных записей, от которого закрыт
 * вход. Владелец занятого, но не подтверждённого адреса при этом получает
 * письмо повторно, а владелец подтверждённого — ничего: войти он может и так.
 *
 * Правила пароля проверяются здесь, а не политикой области провайдера:
 * политика области распространилась бы и на учебные учётные записи
 * сотрудников из файла области, и провайдер отказался бы его загружать.
 * Самостоятельная регистрация идёт только через шлюз, поэтому для клиентов
 * правило действует всегда.
 */

export interface RegistrationInput {
  email?: string;
  password?: string;
  name?: string;
}

export interface RegistrationResult {
  status: "verification-sent";
  email: string;
}

/** Простая проверка формы адреса; настоящая проверка — само письмо. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_NAME = 100;

@Injectable()
export class RegistrationService {
  private readonly logger: Logger;

  constructor(
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(GATEWAY_CONFIG) config: GatewayConfig,
  ) {
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "registration",
    });
  }

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    const email = normalizeEmail(input.email);
    const password = input.password ?? "";
    const name = input.name?.trim() || undefined;

    if (password.length < MIN_PASSWORD) {
      throw new ValidationError(
        `пароль слишком короткий: нужно не меньше ${MIN_PASSWORD} символов`,
      );
    }
    if (password.toLowerCase() === email || password.toLowerCase() === email.split("@")[0]) {
      throw new ValidationError("пароль не должен совпадать с e-mail");
    }
    if (name && name.length > MAX_NAME) {
      throw new ValidationError(`имя длиннее ${MAX_NAME} символов`);
    }

    const created = await this.accounts.create({ email, password, firstName: name });
    if (created) {
      await this.accounts.sendVerificationEmail(created);
      this.logger.info("зарегистрирован клиент, отправлено письмо подтверждения", {
        userId: created,
      });
    } else {
      await this.resendIfUnverified(email);
    }

    return { status: "verification-sent", email };
  }

  /** Повторное письмо: ответ тоже не говорит, есть ли такой адрес. */
  async resend(rawEmail: string | undefined): Promise<RegistrationResult> {
    const email = normalizeEmail(rawEmail);
    await this.resendIfUnverified(email);
    return { status: "verification-sent", email };
  }

  private async resendIfUnverified(email: string): Promise<void> {
    const account = await this.accounts.findByEmail(email);
    if (!account || account.emailVerified) return;

    await this.accounts.sendVerificationEmail(account.id);
    this.logger.info("повторно отправлено письмо подтверждения", { userId: account.id });
  }
}

function normalizeEmail(raw: string | undefined): string {
  const email = raw?.trim().toLowerCase() ?? "";
  if (!EMAIL.test(email) || email.length > 254) {
    throw new ValidationError("укажите e-mail вида name@example.com");
  }
  return email;
}
