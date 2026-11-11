import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { retryOnCi } from "../../scripts/flakes/retry/vitest"

const config = defineConfig({
  plugins: [react(), tailwindcss()],
})

export default retryOnCi(config)
