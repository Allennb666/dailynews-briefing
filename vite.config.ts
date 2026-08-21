import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative assets work both at the repository Pages URL
  // (/dailynews-briefing/) and at the custom-domain root (/).
  base: './',
  plugins: [react()],
})
