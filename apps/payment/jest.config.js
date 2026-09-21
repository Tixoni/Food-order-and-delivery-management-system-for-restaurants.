/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testMatch: ["**/*.spec.ts"],
  collectCoverageFrom: ["**/*.ts", "!**/main.ts", "!**/*.module.ts"],
  coverageDirectory: "../coverage",
};
