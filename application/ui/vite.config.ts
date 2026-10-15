import { resolve } from "node:path"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv, type ConfigEnv, type Plugin } from "vite"

import { boundaryViolations } from "./src/bundle-boundary"
import { buildConnectSources } from "./src/content-security-policy"
import { tryHeaders } from "./src/hosting-headers"
import { withSearchVisibility } from "./src/search-visibility"

const connectSourcesPlaceholder = "__NOVADECK_CONNECT_SOURCES__"

const contentSecurityPolicy = (): Plugin => {
  let environment: ConfigEnv
  let apiUrl: string | undefined
  let runnerUrl: string | undefined

  return {
    name: "novadeck-content-security-policy",
    config(_config, configEnvironment) {
      environment = configEnvironment
      const fileEnvironment = loadEnv(environment.mode, process.cwd(), "VITE_")
      apiUrl = process.env.VITE_API_URL ?? fileEnvironment.VITE_API_URL
      runnerUrl = process.env.VITE_NOVADECK_RUNNER_URL ?? fileEnvironment.VITE_NOVADECK_RUNNER_URL
    },
    transformIndexHtml(html) {
      if (!html.includes(connectSourcesPlaceholder)) {
        throw new Error("Content Security Policy connect-src placeholder is missing")
      }

      const sources = buildConnectSources(environment, apiUrl, runnerUrl)
      return withSearchVisibility(
        html.replace(connectSourcesPlaceholder, sources.join(" ")),
        environment.mode,
      )
    },
  }
}

// Gives the visitor build the response headers its host serves it with (see
// src/hosting-headers.ts).
const hostingHeaders = (): Plugin => {
  let mode = ""
  return {
    name: "novadeck-hosting-headers",
    apply: "build",
    configResolved: (config) => void (mode = config.mode),
    generateBundle() {
      if (mode === "try")
        this.emitFile({ type: "asset", fileName: "_headers", source: tryHeaders() })
    },
  }
}

// Fails a build that carries an adapter its mode must not (see src/bundle-boundary.ts).
const bundleBoundary = (): Plugin => {
  let mode = ""
  return {
    name: "novadeck-bundle-boundary",
    apply: "build",
    configResolved: (config) => void (mode = config.mode),
    generateBundle(_options, bundle) {
      const violations = Object.values(bundle).flatMap((chunk) =>
        chunk.type === "chunk" ? boundaryViolations(mode, Object.keys(chunk.modules)) : [],
      )
      if (violations.length > 0) {
        this.error(`The ${mode} build carries modules it must not: ${violations.join(", ")}`)
      }
    },
  }
}

export default defineConfig({
  base: "./",
  // The demo always previews the welcome dialog; Vitest keeps explicit first-run fixtures.
  define: {
    "import.meta.env.VITE_WELCOME_PREVIEW": JSON.stringify(
      process.env.VITEST === "true" ? "false" : "true",
    ),
  },
  build: {
    manifest: true,
    // Fonts always ship as files: the Content Security Policy loads them only from the
    // app itself, so a small subset Vite would inline as a data: URL would be blocked.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
  plugins: [tailwindcss(), react(), contentSecurityPolicy(), bundleBoundary(), hostingHeaders()],
  resolve: {
    alias: [{ find: /^react$/, replacement: resolve("node_modules/react/index.js") }],
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
