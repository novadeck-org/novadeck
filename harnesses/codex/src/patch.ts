import { flavourOf } from "@novadeck/harness-core/paths"

// The lines of a patch that name the files it adds, changes, deletes or moves to.
const patchFile = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

/** The files a patch's text names, as written: relative or absolute, in order. */
export const patchPaths = (text: string): readonly string[] =>
  [...text.matchAll(patchFile)].map(([, path]) => path!.trim())

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
