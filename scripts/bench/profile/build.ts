import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { storeSpansPatch, webglPatch } from "./patches.ts"

// `node scripts/bench/profile/build.ts --out <folder> [--profiling] [--webgl]`: builds the
// desktop app's page as its own build does, with hidden source maps, into `--out`. With `--profiling`, React
// DOM's profiling build stands in for its production one: the same code but for the timings
// React logs as its performance tracks (console.timeStamp), which the profile reads from the
// trace; and, where core/store.ts has its instrumentation hook (`countListenersWoken`, which
// step 1.3a adds), a `performance.measure` span around each run of a store's listeners. With
// `--webgl`, every screen loads xterm's WebGL renderer once it opens, in place of its DOM one,
// the addon the emulator library's own. The patches are in patches.ts.

const app = join(import.meta.dirname, "../../..", "apps/desktop")
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    profiling: { type: "boolean", default: false },
    webgl: { type: "boolean", default: false },
  },
})
if (!values.out) throw new Error("--out names the folder to build into")

// The app's own Vite, as the root has none: only its build is used.
const vite = (await import(
  pathToFileURL(join(app, "node_modules", "vite", "dist", "node", "index.js")).href
)) as { readonly build: (config: Record<string, unknown>) => Promise<unknown> }
process.chdir(app)
await vite.build({
  configFile: join(app, "vite.config.ts"),
  logLevel: "error",
  build: { outDir: values.out, emptyOutDir: true, sourcemap: "hidden" },
  ...(values.profiling && {
    resolve: { alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] },
  }),
  ...((values.webgl || values.profiling) && {
    plugins: [
      ...(values.webgl ? [webglPatch] : []),
      ...(values.profiling ? [storeSpansPatch] : []),
    ],
  }),
})
