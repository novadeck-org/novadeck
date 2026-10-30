import { resolve } from "node:path"

import { bundleChecks, frontendUtilities } from "@novadeck/build-kit/bundle-checks"
import { connectSources } from "@novadeck/build-kit/connect-sources"
import { contentSecurityPolicy } from "@novadeck/build-kit/content-security-policy"
import { fontsAsFiles } from "@novadeck/build-kit/fonts"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The content preview (`pnpm dev:previews`): the demo with its debug panel. The mode is
// `content-preview` (see the scripts in package.json).
const ui = resolve(import.meta.dirname, "../../frontend/ui")

// What index.html's connect-src holds until a build fills it.
const connectSourcesPlaceholder = "__NOVADECK_CONNECT_SOURCES__"

export default defineConfig({
  base: "./",
  // What every page shares stays the UI's: its public files and its env files.
  publicDir: resolve(ui, "public"),
  envDir: ui,
  // The demo always previews the welcome dialog.
  define: { "import.meta.env.VITE_WELCOME_PREVIEW": JSON.stringify("true") },
  build: {
    manifest: true,
    // Fonts always ship as files, which the Content Security Policy allows.
    assetsInlineLimit: fontsAsFiles,
  },
  plugins: [
    tailwindcss(),
    react(),
    contentSecurityPolicy({
      placeholder: connectSourcesPlaceholder,
      connect: (build) =>
        connectSources({
          api: { url: build.env.VITE_API_URL, name: "VITE_API_URL" },
          runner: { url: build.env.VITE_NOVADECK_RUNNER_URL, name: "VITE_NOVADECK_RUNNER_URL" },
          development: build.command === "serve",
        }),
    }),
    bundleChecks({
      // One utility from each folder the UI's stylesheet scans: see the build kit.
      utilities: frontendUtilities,
    }),
  ],
})
