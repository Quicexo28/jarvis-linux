import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  test: { globals: false, environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], testTimeout: 5000 },
})
