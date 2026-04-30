/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/src/__mocks__/obsidian.ts'
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        target: 'ES2019',
        esModuleInterop: true,
        isolatedModules: true,
        strictNullChecks: true,
        noImplicitAny: false,
        skipLibCheck: true,
        lib: ['DOM', 'ES2019']
      }
    }]
  }
};
