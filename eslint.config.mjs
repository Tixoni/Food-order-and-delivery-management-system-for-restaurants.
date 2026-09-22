// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Правила проверки кода.
 *
 * Помимо обычных правил здесь описано ГЛАВНОЕ архитектурное ограничение проекта:
 * доменный слой не имеет права зависеть от инфраструктуры. Без автоматической
 * проверки это правило живёт только в голове и нарушается молча.
 * См. заметку «16 — Структура кода сервиса».
 */

/** Инфраструктурные пакеты, которых доменный слой не должен видеть. */
const INFRASTRUCTURE_PACKAGES = [
  "typeorm",
  "pg",
  "kafkajs",
  "ioredis",
  "redis",
  "@nestjs/*",
  "express",
  "axios",
  "node-fetch",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "spikes/**", // одноразовые эксперименты под общие правила не подпадают
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // Сравнение с null нестрогое разрешено намеренно: `x != null` —
      // общепринятая запись проверки «ни null, ни undefined». Остальные
      // нестрогие сравнения остаются ошибкой.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  /* ────────────────────────────────────────────────────────────────
     Правило зависимостей: домен ничего не знает об инфраструктуре.
     Нарушение границы слоя — ошибка, а не замечание.
     ──────────────────────────────────────────────────────────────── */
  {
    files: ["apps/*/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: INFRASTRUCTURE_PACKAGES,
              message:
                "Доменный слой не должен зависеть от инфраструктуры. " +
                "Опишите нужную операцию интерфейсом (портом) в слое application " +
                "и реализуйте его в infrastructure.",
            },
            {
              group: ["**/infrastructure/**", "**/interface/**"],
              message:
                "Доменный слой не должен обращаться к слоям infrastructure и interface. " +
                "Зависимости направлены только внутрь, к домену.",
            },
          ],
        },
      ],
    },
  },

  /* Слой application знает домен, но не знает, чем именно он реализован. */
  {
    files: ["apps/*/src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/infrastructure/**", "**/interface/**"],
              message:
                "Слой application работает с портами, а не с их реализациями. " +
                "Конкретная реализация подставляется через внедрение зависимостей.",
            },
          ],
        },
      ],
    },
  },

  /* ────────────────────────────────────────────────────────────────
     Сервисы на NestJS: внедрение зависимостей опирается на сведения
     о типах, которые компилятор записывает в метаданные. Пометка
     импорта как типового убирает его из скомпилированного кода —
     и внедрение перестаёт работать. Поэтому правило здесь выключено.
     Исключение распространяется и на packages/service-kit — общий каркас
     сервиса тоже построен на декораторах. В остальных пакетах правило
     остаётся: там декораторов нет.
     ──────────────────────────────────────────────────────────────── */
  {
    files: ["apps/**/*.ts", "packages/service-kit/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },

  /* ────────────────────────────────────────────────────────────────
     Служебные сценарии (миграции, наполнение данными) запускаются
     вручную из командной строки, и вывод в консоль — их прямое
     назначение, а не забытая отладочная печать. В сервисах вывод
     идёт через журнал, поэтому там правило остаётся.
     ──────────────────────────────────────────────────────────────── */
  {
    files: ["infra/**/*.mjs", "infra/**/*.js"],
    rules: {
      "no-console": "off",
    },
  },

  /* Тесты живут по более мягким правилам. */
  {
    files: ["**/*.spec.ts", "**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  prettier,
);
