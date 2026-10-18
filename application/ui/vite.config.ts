import { resolve } from "node:path"

import { contentSecurityPolicy } from "@novadeck/build-kit/content-security-policy"
import { fontsAsFiles } from "@novadeck/build-kit/fonts"
import { hostingHeaders } from "@novadeck/build-kit/hosting-headers"
import { searchVisibility } from "@novadeck/build-kit/search-visibility"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

import { boundaryViolations } from "./src/bundle-boundary"
import { connect, connectSourcesPlaceholder, headerRules, hidden } from "./src/deploy"

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
    // Fonts always ship as files, which the Content Security Policy allows.
    assetsInlineLimit: fontsAsFiles,
  },
  // How each build is deployed is the app's (see src/deploy.ts); the build kit applies it.
  plugins: [
    tailwindcss(),
    react(),
    contentSecurityPolicy({ placeholder: connectSourcesPlaceholder, connect }),
    searchVisibility({ hidden }),
    bundleBoundary(),
    hostingHeaders({ rules: headerRules }),
  ],
  resolve: {
    alias: [{ find: /^react$/, replacement: resolve("node_modules/react/index.js") }],
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
