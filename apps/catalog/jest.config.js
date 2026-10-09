/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testMatch: ["**/*.spec.ts"],
  collectCoverageFrom: [
    "**/*.ts",
    "!**/main.ts",
    "!**/*.module.ts",
    // Заглушки портов — часть тестов, а не проверяемый код
    "!**/*.doubles.ts",
  ],
  coverageDirectory: "../coverage",
  moduleNameMapper: {
    "^@food-delivery/shared$": "<rootDir>/../../../packages/shared/src",
    "^@food-delivery/contracts$": "<rootDir>/../../../packages/contracts/src",
  },
};
