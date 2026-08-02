import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs work both at the domain root and under a GitHub Pages
  // repository path (for example, /minehut-name-checker/).
  base: './',
  plugins: [vue(), tailwindcss()],
})
