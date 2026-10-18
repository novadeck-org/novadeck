import { isAbsolute, resolve } from "node:path"

import { contentSecurityPolicy } from "@novadeck/build-kit/content-security-policy"
import { fontsAsFiles } from "@novadeck/build-kit/fonts"
import { hostingHeaders } from "@novadeck/build-kit/hosting-headers"
import { searchVisibility } from "@novadeck/build-kit/search-visibility"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

import { boundaryViolations } from "./src/bundle-boundary"
import { connect, connectSourcesPlaceholder, headerRules, hidden } from "./src/deploy"

// Each app is an entry of its own, by the mode that names it: its page is entries/<name>/index.html,
// served at its server's root and built to its own folder, so a deploy carries only its own
// entry. The desktop app's stays the package's index.html, built to dist/, which the host
// packages and loads, and the dev server's root page, which the host loads in development.
// Tests keep the package's root too.
const entries: Readonly<Record<string, { readonly root: string; readonly outDir: string }>> = {
  web: { root: "entries/web", outDir: "dist-web" },
  try: { root: "entries/try", outDir: "dist-try" },
  "content-preview": { root: "entries/previews", outDir: "dist-previews" },
}

// A path of the package's, as an entry's config gives it.
const own = (path: string): string => (isAbsolute(path) ? path : resolve(import.meta.dirname, path))

const entryOf = (): Plugin => ({
  name: "novadeck-entry",
  config(config, { mode }) {
    const entry = entries[mode]
    if (!entry) return
    return {
      root: own(entry.root),
      // What every entry shares stays the package's: its public files and its env files.
      publicDir: own("public"),
      envDir: import.meta.dirname,
      // An outDir given on the command line is the package's, as it was before entries. It's
      // outside the entry's root, which Vite empties only when told.
      build: {
        outDir: own(config.build?.outDir ?? entry.outDir),
        emptyOutDir: config.build?.emptyOutDir ?? true,
      },
    }
  },
})

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
    entryOf(),
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
