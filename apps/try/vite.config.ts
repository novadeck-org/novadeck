import { resolve } from "node:path"

import { bundleChecks, frontendUtilities } from "@novadeck/build-kit/bundle-checks"
import { contentSecurityPolicy } from "@novadeck/build-kit/content-security-policy"
import { fontsAsFiles } from "@novadeck/build-kit/fonts"
import { hostingHeaders } from "@novadeck/build-kit/hosting-headers"
import { searchVisibility } from "@novadeck/build-kit/search-visibility"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { connect, headerRules, hidden } from "./src/deploy"

// The visitor build, for a website: the demo without its debug panel. The mode is `try`
// (see the scripts in package.json); how the build is deployed is src/deploy.ts.
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
    contentSecurityPolicy({ connect }),
    searchVisibility({ hidden }),
    bundleChecks({
      // One utility from each folder the UI's stylesheet scans: see the build kit.
      utilities: frontendUtilities,
      // What the page loads first, and the demo, which loads with its connection.
      budgets: {
        first: 1_300_000,
        demo: 190_000,
        demoModule: "/frontend/demo/src/visitor/connect.ts",
      },
    }),
    hostingHeaders({ rules: headerRules }),
  ],
})
