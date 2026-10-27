import { efforts, type Effort, type Model } from "@novadeck/harness-core/harness"

// A model id ends in the one effort it runs at (`gemini-3.8-flash-high`), or in none, and
// then takes no `--effort` at all: Antigravity refuses any other.
const effortOf = (id: string): readonly Effort[] => {
  const suffix = id.slice(id.lastIndexOf("-") + 1)
  return efforts.filter((effort) => effort === suffix)
}

/**
 * The models `agy models` prints: a banner line, then one `<id>\t<display name>` per model.
 * A model takes only the effort its id ends with, and none where it ends in no effort.
 */
export const parseModels = (output: string): readonly Model[] =>
  output
    .split(/\r?\n/)
    .filter((line) => line.includes("\t"))
    .map((line) => line.slice(0, line.indexOf("\t")).trim())
    .filter((id) => id !== "" && !/\s/.test(id))
    .map((id) => ({ id, efforts: effortOf(id) }))
