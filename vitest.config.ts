import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
  // Vitest 4 移除了 `test.server.fs`；文件服务白名单走 Vite 顶层 `server.fs.allow`。
  // The E2E suite imports the monorepo's scripted MockAdapter
  // (`deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts`),
  // which lives outside this package root.
  server: {
    fs: {
      allow: ['../deepseek-harness'],
    },
  },
})
