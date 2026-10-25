import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import {
  mustRunOnce,
  profileTextPatch,
  raisedCapPatch,
  softwareWebglPatch,
  storeSpansPatch,
  webglAtlasPatch,
} from "./patches.ts"

// `node scripts/bench/profile/build.ts --out <folder> [--profiling] [--plain] [--contexts <n>]
// [--software-webgl]`: builds the desktop app's page as its own build does, with hidden source
// maps, into `--out`. Unless `--plain`, the build carries the profile's bench-only patches
// (patches.ts), none of them the product's: every screen's `profileText`, so a probe reads a
// WebGL screen's text, and a registry of the live WebGL addons, for their atlases. With
// `--profiling`, React DOM's profiling build stands in for its production one: the same code
// but for the timings React logs as its performance tracks (console.timeStamp), which the
// profile reads from the trace; and, where core/store.ts has its instrumentation hook
// (`countListenersWoken`, which step 1.3a adds), a `performance.measure` span around each run
// of a store's listeners. With `--contexts n`, the page's pool takes n - 2 contexts, to go
// with Electron's `--max-active-webgl-contexts=n`. With `--software-webgl`, the pool takes
// software WebGL, for a smoke test under a virtual display.

const app = join(import.meta.dirname, "../../..", "apps/desktop")
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    profiling: { type: "boolean", default: false },
    plain: { type: "boolean", default: false },
    contexts: { type: "string" },
    "software-webgl": { type: "boolean", default: false },
  },
})
if (!values.out) throw new Error("--out names the folder to build into")
const contexts = values.contexts === undefined ? undefined : Number(values.contexts)
if (contexts !== undefined && (!Number.isInteger(contexts) || contexts < 3))
  throw new Error(`--contexts takes a whole number, 3 or more: ${values.contexts}`)

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
  ...(!values.plain && {
    plugins: [
      mustRunOnce(profileTextPatch),
      mustRunOnce(webglAtlasPatch),
      ...(values["software-webgl"] ? [mustRunOnce(softwareWebglPatch)] : []),
      ...(contexts === undefined ? [] : [mustRunOnce(raisedCapPatch(contexts))]),
      ...(values.profiling ? [storeSpansPatch] : []),
    ],
  }),
})
