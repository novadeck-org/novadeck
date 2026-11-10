import { defineConfig } from "vitest/config"

// The main process's tests, and the checks of the pages and the package, in Node. Without this
// file Vitest would take vite.config.ts, the pages' build, rooted in renderer/. The Electron
// binary is fetched once before the workers start (scripts/electron-binary.ts).
export default defineConfig({ test: { globalSetup: ["./scripts/electron-binary.ts"] } })
