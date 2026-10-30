import { resolve } from "node:path"

import { bundleChecks, frontendUtilities } from "@novadeck/build-kit/bundle-checks"
import { configuredSources } from "@novadeck/build-kit/connect-sources"
import { contentSecurityPolicy } from "@novadeck/build-kit/content-security-policy"
import { fontsAsFiles } from "@novadeck/build-kit/fonts"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The content preview (`pnpm dev:previews`): the demo with its debug panel. The mode is
// `content-preview` (see the scripts in package.json).
const ui = resolve(import.meta.dirname, "../../frontend/ui")

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
    // It reaches what it is configured for.
    contentSecurityPolicy({ connect: configuredSources }),
    bundleChecks({
      // One utility from each folder the UI's stylesheet scans: see the build kit.
      utilities: frontendUtilities,
    }),
  ],
})
