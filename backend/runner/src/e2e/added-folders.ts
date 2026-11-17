import { readFileSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

import { rootsGiven } from "@novadeck/harness-codex/roots"
import { addedFolders } from "@novadeck/harness-core/decode"
import type { Harness } from "@novadeck/harness-core/harness"

import { agents, harnesses } from "../harnesses/registry.js"

// Whether `folder` is a whole path outside `root`, which a sandboxed launch never needs; a
// relative one is the launch's own, within its folder.
const outside = (folder: string, root: string): boolean => {
  if (!isAbsolute(folder)) return false
  // Another drive on Windows has no relative path, only its own.
  const within = relative(root, folder)
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

// `permissions.additionalDirectories` in settings given with `--settings`, a file's or a JSON
// text's, as Claude Code takes either; undefined where they don't read, which the check can't
// vouch for. The shims give the file by its whole path.
const settingsFolders = (settings: string): readonly string[] | undefined => {
  try {
    const text = settings.trimStart().startsWith("{") ? settings : readFileSync(settings, "utf8")
    const folders = (JSON.parse(text) as { permissions?: { additionalDirectories?: unknown } })
      .permissions?.additionalDirectories
    return Array.isArray(folders)
      ? folders.filter((folder): folder is string => typeof folder === "string")
      : []
  } catch {
    return undefined
  }
}

/**
 * How a launch's words give its agent a folder outside the sandbox's `root`, each as one: with `--add-dir`,
 * in `--settings`' `additionalDirectories`, or in `-c` writable roots, whichever harness was
 * started with them: the ways Novadeck's shims give the folder of agents' worktrees
 * (Antigravity, Claude Code and Codex in turn). Settings that don't read count as one, as
 * nothing then says where they lead. The probes give folders of their own in the sandbox,
 * beside its home.
 */
export const addedOutside = (words: readonly string[], root: string): readonly string[] => [
  ...addedFolders(words)
    .filter((folder) => outside(folder, root))
    .map((folder) => `with --add-dir ${folder}`),
  ...valuesOf(words, "--settings").flatMap((settings) => {
    const folders = settingsFolders(settings)
    return folders === undefined
      ? [`with --settings ${settings}, which don't read`]
      : folders
          .filter((folder) => outside(folder, root))
          .map((folder) => `with ${folder} in its --settings' additionalDirectories`)
  }),
  ...rootsGiven(words)
    .filter((folder) => outside(folder, root))
    .map((folder) => `with ${folder} in its -c writable_roots`),
]

/**
 * Watches every agent process that reports, by the words the relay read it was started with
 * (`Report.launch`), for a folder given outside the sandbox's `root` (`addedOutside`), as the
 * developer's own `~/.novadeck/worktrees` once was; `stop` lets the harnesses go.
 */
export const watchAddedFolders = (
  root: string,
): { readonly outside: () => readonly string[]; readonly stop: () => void } => {
  const found = new Set<string>()
  const restores = agents.map((agent) => {
    const harness = harnesses[agent] as { decode: Harness["decode"] }
    const decode = harness.decode
    harness.decode = (report) => {
      for (const how of addedOutside(report.launch ?? [], root))
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
