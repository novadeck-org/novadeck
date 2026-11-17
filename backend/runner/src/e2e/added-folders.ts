import { readFileSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

import { rootsGiven } from "@novadeck/harness-codex/roots"
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

// Whether `folder` is a whole path outside `home`, which a sandboxed launch never needs; a
// relative one is the launch's own, within its folder.
const outside = (folder: string, home: string): boolean => {
  if (!isAbsolute(folder)) return false
  // Another drive on Windows has no relative path, only its own.
  const within = relative(home, folder)
  return isAbsolute(within) || within.split(/[\\/]/)[0] === ".."
}

// The values a launch gives an option, as `<option>=<value>` or `<option> <value>`.
const valuesOf = (words: readonly string[], option: string): readonly string[] =>
  words.flatMap((word, at, all) =>
    word.startsWith(`${option}=`)
      ? [word.slice(option.length + 1)]
      : word === option && all[at + 1] !== undefined
        ? [all[at + 1]!]
        : [],
  )

// Claude Code's `permissions.additionalDirectories` in settings given with `--settings`, a
// file's or a JSON text's, as Claude Code takes either; none where they don't read.
const settingsFolders = (settings: string): readonly string[] => {
  try {
    const text = settings.trimStart().startsWith("{") ? settings : readFileSync(settings, "utf8")
    const folders = (JSON.parse(text) as { permissions?: { additionalDirectories?: unknown } })
      .permissions?.additionalDirectories
    return Array.isArray(folders)
      ? folders.filter((folder): folder is string => typeof folder === "string")
      : []
  } catch {
    return []
  }
}

/**
 * How a launch's words give its agent a folder outside `home`, each as one: with `--add-dir`
 * (any harness), in `--settings`' `additionalDirectories` (Claude Code), or in `-c` writable
 * roots (Codex), the ways Novadeck's shims give the folder of agents' worktrees. The settings
 * file itself is the shims' own, in the runner's data beside the sandbox's home.
 */
export const addedOutside = (words: readonly string[], home: string): readonly string[] => [
  ...addedFolders(words)
    .filter((folder) => outside(folder, home))
    .map((folder) => `with --add-dir ${folder}`),
  ...valuesOf(words, "--settings")
    .flatMap(settingsFolders)
    .filter((folder) => outside(folder, home))
    .map((folder) => `with ${folder} in its --settings' additionalDirectories`),
  ...rootsGiven(words)
    .filter((folder) => outside(folder, home))
    .map((folder) => `with ${folder} in its -c writable_roots`),
]

/**
 * Watches every agent process that reports, by the words the relay read it was started with
 * (`Report.launch`), for a folder given outside the sandbox's `home` (`addedOutside`), as the
 * developer's own `~/.novadeck/worktrees` once was; `stop` lets the harnesses go.
 */
export const watchAddedFolders = (
  home: string,
): { readonly outside: () => readonly string[]; readonly stop: () => void } => {
  const found = new Set<string>()
  const restores = agents.map((agent) => {
    const harness = harnesses[agent] as { decode: Harness["decode"] }
    const decode = harness.decode
    harness.decode = (report) => {
      for (const how of addedOutside(report.launch ?? [], home))
        found.add(`${report.agent} was started ${how}`)
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
