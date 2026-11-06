import { changeOf, joinedChange } from "@novadeck/harness-core/outcomes"
import { flavourOf } from "@novadeck/harness-core/paths"
import type { ToolChange } from "@novadeck/protocol"

// The lines of a patch that name the files it adds, changes, deletes or moves to.
const patchFile = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

/** The files a patch's text names, as written: relative or absolute, in order. */
export const patchPaths = (text: string): readonly string[] =>
  [...text.matchAll(patchFile)].map(([, path]) => path!.trim())

// A patch's text between its marks, as the tool takes it or a shell's heredoc holds it, and
// what starts each file's part of it.
const patchBody = /^\*\*\* Begin Patch\r?\n([\s\S]*?)^\*\*\* End Patch\s*$/m
const filePart = /^\*\*\* (Add|Update|Delete) File: [^\n]*\r?\n/gm

// What one file's part changes: a new file's `+` lines, or an update's lines, numbered nowhere,
// as a patch finds its place by the text around it.
const partChange = (kind: string, body: string): ToolChange | undefined => {
  const lines = body.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  if (kind === "Add")
    return changeOf(lines.map((line, at) => ({ sign: "+", text: line.slice(1), line: at + 1 })))
  if (kind !== "Update") return undefined
  return changeOf(
    lines.flatMap((line) => {
      const sign = line[0]
      return sign === "+" || sign === "-" || sign === " "
        ? [{ sign, text: line.slice(1), line: null }]
        : []
    }),
  )
}

/**
 * The lines a patch's text changes, or null for text that holds no patch, or a patch that
 * deletes a file, whose lines it doesn't name. Codex's own account of a patch, with the lines'
 * numbers, comes as its `FileChange` (see `fileChange`), where a call inside a script has it.
 */
export const patchChange = (text: string): ToolChange | null => {
  const body = patchBody.exec(text)?.[1]
  if (body === undefined) return null
  const heads = [...body.matchAll(filePart)]
  const parts = heads.map((head, index) =>
    partChange(
      head[1]!,
      body.slice(head.index + head[0].length, heads[index + 1]?.index ?? body.length),
    ),
  )
  return parts.length > 0 && parts.every((part) => part !== undefined) ? joinedChange(parts) : null
}

/**
 * Whether a patch's PostToolUse response does not say it failed. Codex answers a patch it
 * applied "Success. Updated the following files: ..." (seen from the shell's, 0.159.3); a
 * text that begins otherwise (a failed verification) names no file. A response of no text
 * is no word of failure. Its response for the tool itself is unprobed: the fake model's
 * Codex is offered none, and a rollout's completed `FileChange` backs this up.
 */
export const applied = (response: unknown): boolean =>
  typeof response !== "string" || response.trim() === "" || /^Success\b/.test(response.trim())

/**
 * The files a tool call's patch wrote, as Codex's apply_patch names them in its input,
 * from the session's directory; none for any other call.
 */
export const patched = (input: unknown, cwd: string | undefined): readonly string[] => {
  if (typeof input !== "object" || input === null) return []
  const texts = Object.values(input).filter((value): value is string => typeof value === "string")
  return texts
    .flatMap(patchPaths)
    .flatMap((path) =>
      flavourOf(path, cwd).isAbsolute(path)
        ? [flavourOf(path).normalize(path)]
        : cwd !== undefined
          ? [flavourOf(path, cwd).resolve(cwd, path)]
          : [],
    )
}
