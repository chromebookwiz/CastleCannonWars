import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three') || id.includes('node_modules/@dimforge/rapier3d-compat')) {
            return 'engine'
          }
          return undefined
        },
      },
    },
  },
})