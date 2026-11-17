import { isAbsolute, relative } from "node:path"

import { addedFolders } from "@novadeck/harness-core/decode"
import type { Harness } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { agents, harnesses } from "../harnesses/registry.js"

/**
 * What keeps a harness's agents from starting while the folder of agents' worktrees is
 * there, which their shims then pass on as `--add-dir`: for Claude Code always, for Codex
 * only where it starts read-only, as the tour's teammates do. A scenario with that folder
 * there and one of them is skipped, naming what it waits on, until the fix lands: marked to
 * fail instead, it would also pass with any of the fixture's own checks failing.
 */
const addDirWaits = {
  claude: "Claude Code 2.1.326 asks before it takes --add-dir (fix/claude-add-dir-prompt)",
  codexReadOnly: "Codex under a read-only sandbox refuses --add-dir and exits",
} as const

/**
 * What a scenario run with the harnesses of `team` waits on, if anything; `readOnly` where
 * its Codex agents start read-only.
 */
export const waitsOn = (
  team: readonly AgentName[],
  { readOnly = false }: { readonly readOnly?: boolean } = {},
): string | undefined =>
  [
    ...(team.includes("claude") ? [addDirWaits.claude] : []),
    ...(readOnly && team.includes("codex") ? [addDirWaits.codexReadOnly] : []),
  ].join("; ") || undefined

/** Those of them named by a whole path outside `home`, which a sandboxed launch never needs. */
export const addedOutside = (words: readonly string[], home: string): readonly string[] =>
  addedFolders(words).filter((folder) => {
    if (!isAbsolute(folder)) return false
    // Another drive on Windows has no relative path, only its own.
    const within = relative(home, folder)
    return isAbsolute(within) || within.split(/[\\/]/)[0] === ".."
  })

/**
 * Watches every agent process that reports, by the words the relay read it was started with
 * (`Report.launch`), for a folder given with `--add-dir` outside the sandbox's `home`, as
 * the developer's own `~/.novadeck/worktrees` once was; `stop` lets the harnesses go.
 */
export const watchAddedFolders = (
  home: string,
): { readonly outside: () => readonly string[]; readonly stop: () => void } => {
  const found = new Set<string>()
  const restores = agents.map((agent) => {
    const harness = harnesses[agent] as { decode: Harness["decode"] }
    const decode = harness.decode
    harness.decode = (report) => {
      for (const folder of addedOutside(report.launch ?? [], home))
        found.add(`${report.agent} was started with --add-dir ${folder}`)
      return decode(report)
    }
    return () => {
      harness.decode = decode
    }
  })
  return {
    outside: () => [...found],
    stop: () => {
      for (const restore of restores) restore()
    },
  }
}
