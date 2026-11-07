import { resolve } from "node:path"

import { bundleChecks, frontendUtilities } from "@novadeck/build-kit/bundle-checks"
import { contentSecurityPolicy } from "@novadeck/build-kit/content-security-policy"
import { fontsAsFiles } from "@novadeck/build-kit/fonts"
import { hostingHeaders } from "@novadeck/build-kit/hosting-headers"
import { searchVisibility } from "@novadeck/build-kit/search-visibility"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { connect, headerRules, hidden, notFound } from "./src/deploy"

// The visitor build, for a website: the demo without its debug panel. The mode is `try`
// (see the scripts in package.json); how the build is deployed is src/deploy.ts.
const ui = resolve(import.meta.dirname, "../../frontend/ui")

export default defineConfig({
  base: "./",
  // What every page shares stays the UI's: its public files and its env files.
  publicDir: resolve(ui, "public"),
  envDir: ui,
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
      // What the page loads first, and the demo, which loads with its connection; the
      // website's hero waits on both. The first load's was set at 1.1 MB from the first build
      // with the demo drawn as terminals (1,058 kB, 663 kB of it the eleven fonts declared),
      // and raised to 1.3 MB in #439, when main sat about 100 bytes under it. The demo's was
      // raised to 195 kB for History's rows, which the demo keeps (190,171 bytes then).
      budgets: {
        first: 1_300_000,
        demo: 195_000,
        demoModule: "/frontend/demo/src/visitor/connect.ts",
      },
    }),
    hostingHeaders({ rules: headerRules }),
    notFound(),
  ],
})
