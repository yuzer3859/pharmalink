import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is the operations portal (web/); the backend's default CORS list allows both.
    port: 5174,
    strictPort: true,
    open: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    // Tests use mocked fetch only: nothing reaches a backend or sends an e-mail.
    restoreMocks: true,
  },
})
