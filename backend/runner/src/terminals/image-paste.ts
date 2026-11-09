// What the runner pastes into an agent's box for an image file it saved (`terminals.upload`),
// so that the agent takes it as an image. Probed 2026-11-08 on Linux (e2e/probes/image-box.e2e.ts),
// a path pasted alone in a bracketed paste:
// - with no space in it, Claude Code, Codex and Antigravity all take the path as an image;
// - with a space, Claude Code takes it bare, but Codex and Antigravity leave it as text; a
//   backslash before each space, or the path in double quotes, is taken by all three.
// The uploads folder may hold spaces (macOS keeps app data under `Application Support`, and a
// Windows profile may be named with one), so the path goes in as a shell would read it as one
// word, as the terminal's own paste does for the same programs (`shellPath` in
// libraries/terminal/src/view/paste.ts, which this mirrors: the runner cannot import the
// browser view, and a Windows path is told by its shape, so both behave alike on any system).
// A file name is safe by `safeName`; only the folders above it can hold other characters.

// Whether a path is a Windows one: on a drive, or a share.
const windowsPath = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)

// What a Windows path may hold to go in as itself, without quotes (see `shellPath` of the view).
const windowsSafe = /^(?:(?![ʰ-ͯ])[\p{L}\p{M}\p{N} ._\-\\:])+$/u

/**
 * The text of the paste for the image file at `path`: the path alone, as a shell reads it as
 * one word (backslashes before special characters; on Windows in double quotes when it has a
 * space or anything but plain characters). Throws for a path with a control character, which
 * would end the paste.
 */
export const imagePaste = (path: string): string => {
  if (/\p{Cc}/u.test(path)) throw new RangeError("An image's path can't hold a control character.")
  if (windowsPath(path)) return windowsSafe.test(path) && !/\s/.test(path) ? path : `"${path}"`
  return path.replace(/([ \t"'`\\()&;|<>$!*?[\]{}#~^])/g, "\\$1")
}
