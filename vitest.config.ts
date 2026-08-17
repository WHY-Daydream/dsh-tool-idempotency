import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // The E2E suite imports the monorepo's scripted MockAdapter
    // (`deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts`),
    // which lives outside this package root.
    server: {
      fs: {
        allow: ['../deepseek-harness'],
      },
    },
  },
})
