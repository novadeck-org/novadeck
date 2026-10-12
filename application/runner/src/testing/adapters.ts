import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)

/**
 * The folder of an adapter package's sources, whose `fixtures` its probes live in:
 * what `loadProbe` takes to read them from outside the package.
 */
export const adapterFolder = (id: string): string =>
  join(dirname(require.resolve(`@novadeck/harness-${id}/package.json`)), "src")
