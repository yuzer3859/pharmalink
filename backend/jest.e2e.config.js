/**
 * Integration / e2e suite: boots the real Nest application against a throwaway Postgres
 * container (see test/global-setup.ts). Kept separate from jest.config.js so `npm test` stays
 * fast and Docker-free.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
  },
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  // One worker: every spec shares the single container database and truncates between tests.
  maxWorkers: 1,
  // Container start + migrate on the first spec is well over Jest's 5s default.
  testTimeout: 120_000,
};
