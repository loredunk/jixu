import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@jixu/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@jixu/adapter-claude': resolve(__dirname, 'packages/adapter-claude/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/__tests__/**/*.test.ts'],
    globals: false,
  },
})
