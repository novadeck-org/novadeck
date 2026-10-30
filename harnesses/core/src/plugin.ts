/** A value as the JSON of a file Novadeck writes: indented, with a closing line break. */
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** Novadeck's plugin, as every harness's manifest describes it. */
export const manifest = {
  name: "novadeck",
  version: "1.2.0",
  description:
    "Tells Novadeck which session runs in its terminal, so it can resume it, lets the agent show you files beside it, and lets agents in Novadeck message each other.",
}

/**
 * The local marketplace Claude Code and Codex both install Novadeck's plugin from, as its
 * `marketplace.json` holds it; its `name` is the marketplace's in their plugin commands.
 */
export const marketplace = {
  name: "novadeck",
  owner: { name: "Novadeck" },
  plugins: [{ name: manifest.name, source: "./novadeck", description: manifest.description }],
}

/** The terminal's variables Novadeck's MCP server is started and finds its runner by. */
export const mcpVariables = [
  "NOVADECK_MCP",
  "NOVADECK_TERMINAL_ID",
  "NOVADECK_REPORT",
  "NOVADECK_REPORT_TOKEN",
] as const
