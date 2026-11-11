import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// A test that fails its first `FIXTURE_FAILS` runs (one by default) and then passes: it counts
// its runs in the folder FIXTURE_STATE names, as each retry starts it afresh.
export const failFirst = (name: string): void => {
  const state = process.env.FIXTURE_STATE
  if (!state) throw new Error("FIXTURE_STATE names no folder")
  mkdirSync(state, { recursive: true })
  const file = join(state, name.replace(/\W+/g, "-"))
  const runs = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1
  writeFileSync(file, String(runs))
  if (runs <= Number(process.env.FIXTURE_FAILS ?? 1))
    throw new Error(`a loaded runner's failure, run ${runs}`)
}
