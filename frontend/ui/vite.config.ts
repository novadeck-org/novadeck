import { isAbsolute, relative, resolve } from "node:path"

import { bundleChecks, frontendUtilities } from "@novadeck/build-kit/bundle-checks"
import { connectSources } from "@novadeck/build-kit/connect-sources"
import { contentSecurityPolicy } from "@novadeck/build-kit/content-security-policy"
import { fontsAsFiles } from "@novadeck/build-kit/fonts"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// The desktop app's build and the browser app's: the two entries that connect to a runner,
// until the desktop entry moves to apps/desktop. The visitor build and the content preview
// are the apps' own (apps/try, apps/previews).
//
// The browser app is an entry of its own, by the mode that names it: its page is
// entries/web/index.html, served at its server's root and built to its own folder. The
// desktop app's stays the package's index.html, built to dist/, which the host packages and
// loads, and the dev server's root page, which the host loads in development. Tests keep the
// package's root too.
const entries: Readonly<Record<string, { readonly root: string; readonly outDir: string }>> = {
  web: { root: "entries/web", outDir: "dist-web" },
}

// A folder within the package, not the package itself.
const inPackage = (path: string): boolean => {
  const within = relative(import.meta.dirname, path)
  return within !== "" && !within.startsWith("..") && !isAbsolute(within)
}

// A path of the package's, as an entry's config gives it.
const own = (path: string): string => (isAbsolute(path) ? path : resolve(import.meta.dirname, path))

// The modes that build the desktop app, from the package's own root; any other names an entry.
const desktopModes = new Set(["production", "development", "test"])

const entryOf = (): Plugin => ({
  name: "novadeck-entry",
  config(config, { mode }) {
    const entry = entries[mode]
    if (!entry) {
      if (desktopModes.has(mode)) return
      throw new Error(`No entry is named ${mode}: the modes are ${Object.keys(entries).join(", ")}`)
    }
    const outDir = own(config.build?.outDir ?? entry.outDir)
    return {
      root: own(entry.root),
      // What every entry shares stays the package's: its public files and its env files.
      publicDir: own("public"),
      envDir: import.meta.dirname,
      // An outDir given on the command line is the package's, as it was before entries. It's
      // outside the entry's root, which Vite empties only when told.
      build: {
        outDir,
        // Within the package only, as Vite itself empties only its root's: never a folder elsewhere.
        ...((config.build?.emptyOutDir ?? inPackage(outDir)) && { emptyOutDir: true }),
      },
    }
  },
})

// What index.html's connect-src holds until a build fills it.
const connectSourcesPlaceholder = "__NOVADECK_CONNECT_SOURCES__"

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
  plugins: [
    entryOf(),
    tailwindcss(),
    react(),
    // Every build reaches what it is configured for.
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
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(import.meta.dirname, "node_modules/react/index.js") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
