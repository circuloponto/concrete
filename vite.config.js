import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Worklet files must always be emitted as fetchable assets. Safari's
    // AudioWorklet.addModule() rejects base64 data URLs, and the WASM-backed
    // worklets (signalsmith-stretch et al) would bloat the main chunk if inlined.
    assetsInlineLimit: (filePath) => {
      if (/\.worklet\.(js|ts)$/.test(filePath)) return 0
      if (/\.worker\.(js|ts)$/.test(filePath)) return 0
      if (/\.wasm$/.test(filePath)) return 0
      return 4096
    },
  },
})
