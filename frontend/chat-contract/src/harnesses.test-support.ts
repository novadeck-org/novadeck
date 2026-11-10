import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import type { AgentName } from "@novadeck/protocol/harnesses"

const require = createRequire(import.meta.url)

/**
 * A harness package's sources, found by its name, as this package depends on each: the package
 * graph then sees what its tests read there (a path past the package would hide it).
 */
export const harnessSources = (harness: AgentName | "core"): string =>
  join(dirname(require.resolve(`@novadeck/harness-${harness}/package.json`)), "src")
