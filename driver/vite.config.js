import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is the operations portal (web/), 5174 the customer app (app/); the backend's default
    // CORS list allows all three.
    port: 5175,
    strictPort: true,
    open: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    // Tests use a scripted fetch only: nothing reaches a backend.
    restoreMocks: true,
  },
})
