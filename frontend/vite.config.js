import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // This makes it accessible on your LAN
    port: process.env.PORT || 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_API_ORIGIN || 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path
      }
    }
  }
});
