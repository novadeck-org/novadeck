import { resolve } from "node:path"

import { build } from "esbuild"
import type { Plugin } from "vite"

// A viewer's code as its sandboxed frame runs it (libraries/viewers/src/frame): the frame
// takes classic scripts as text, never a module by its address, which it can't load. So
// `import code from "<module>?frame"` is that module and all it imports (three.js, say),
// bundled into one minified classic script, as a string the app hands the frame. Import it
// lazily, so the app's own chunks don't carry it.

const query = "?frame"
const prefix = "\0frame:"

export const frameBundles = (): Plugin => ({
  name: "novadeck:frame-bundles",
  enforce: "pre",
  async resolveId(source, importer) {
    if (!source.endsWith(query)) return null
    const found = await this.resolve(source.slice(0, -query.length), importer, { skipSelf: true })
    return found ? `${prefix}${found.id}` : null
  },
  async load(id) {
    if (!id.startsWith(prefix)) return null
    const entry = id.slice(prefix.length)
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
      // Its dependencies' licences, kept with their code.
      legalComments: "inline",
      write: false,
      metafile: true,
      logLevel: "silent",
    })
    // A change to any file it bundles builds it again.
    for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(resolve(input))
    return `export default ${JSON.stringify(result.outputFiles[0]!.text)}`
  },
})
