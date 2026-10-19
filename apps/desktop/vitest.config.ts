import { defineConfig } from "vitest/config"

// The main process's tests, and the checks of the pages and the package, in Node. Without this
// file Vitest would take vite.config.ts, the pages' build, rooted in renderer/.
export default defineConfig({ test: {} })
