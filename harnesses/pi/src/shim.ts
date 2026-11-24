import type { Harness } from "@novadeck/harness-core/harness"
import type { KeptFlags } from "@novadeck/harness-core/kept-flags"

/**
 * The words that mark a pi command as no session: its subcommands, and its help, version and
 * listing flags. A skeleton, to be settled with the probes.
 */
export const commands: readonly string[] = [
  "mcp",
  "auth",
  "update",
  "install",
  "remove",
  "list",
  "config",
]
export const info: readonly string[] = ["--help", "-h", "--version", "-v", "--list-models"]
export const valued: readonly string[] = [
  "--model",
  "--provider",
  "--thinking",
  "--session",
  "--session-id",
  "--session-dir",
  "--models",
  "--tools",
  "--api-key",
  "-e",
  "--extension",
]

/**
 * The flags of a launch a resume carries over: its model and thinking level. A skeleton: what pi
 * brings back with its session on its own, and so `forgets`, is to be settled with a probe.
 */
export const kept: KeptFlags = {
  valued: { "--model": "--model", "--thinking": "--thinking" },
  bare: {},
  forgets: [],
  takesValue: valued,
  takesMany: [],
  print: ["-p", "--print"],
  sets: (flag) => (flag === "--model" ? "model" : flag === "--thinking" ? "effort" : undefined),
}

/** Its shims (the program put first on PATH): none yet. */
export const shims: NonNullable<Harness["shims"]> = () => []
