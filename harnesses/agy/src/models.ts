import { efforts, type Effort, type Model } from "@novadeck/harness-core/harness"

// A model id ends in the one effort it runs at (`gemini-3.8-flash-high`), or in none, and
// then takes no `--effort` at all: Antigravity refuses any other.
const effortOf = (id: string): readonly Effort[] => {
  const suffix = id.slice(id.lastIndexOf("-") + 1)
  return efforts.filter((effort) => effort === suffix)
}

// The ids `agy models` lists (1.4.7, 2026-10-27; the same on 1.4.12, 2026-10-31). Novadeck
// doesn't run it to ask: it starts Antigravity's language server, which, signed in, starts
// every plugin's MCP server.
const ids = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
]

/** The models Antigravity starts with, each taking only the effort its id ends with. */
export const models: readonly Model[] = ids.map((id) => ({ id, efforts: effortOf(id) }))
