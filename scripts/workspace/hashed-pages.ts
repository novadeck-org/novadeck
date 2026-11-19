import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// A page whose Content-Security-Policy allows a script by a hash of its text runs that script only
// while the text is exactly what was hashed, bytes and line endings alike. A checkout that writes
// the page with CRLF (Windows, by default) changes the text, the hash no longer matches, and the
// script never runs. So each such page keeps LF through a line in `.gitattributes`; these find
// the pages and what git checks each out with, so one added, moved or renamed without its line
// fails on every system, not only as timeouts on Windows.

/** A source in a policy that allows what matches a hash: `'sha256-…'`, `'sha384-…'`, `'sha512-…'`. */
const hashSource = /^'sha(?:256|384|512)-/i

/** A page's file, by its name. */
const pageFile = /\.x?html?$/i

/** A tag's attributes, by name in lower case, with the few entities a policy's quotes take. */
const attributesOf = (tag: string): ReadonlyMap<string, string> =>
  new Map(
    [...tag.matchAll(/([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)].map(
      ([, name = "", double, single, bare]) => [
        name.toLowerCase(),
        (double ?? single ?? bare ?? "")
          .replaceAll(/&(?:#39|#x27|apos);/gi, "'")
          .replaceAll(/&(?:#34|#x22|quot);/gi, '"')
          .replaceAll(/&amp;/gi, "&"),
      ],
    ),
  )

/** The policies a page sets in its `<meta http-equiv="Content-Security-Policy">` tags. */
export const policiesOf = (html: string): readonly string[] =>
  [...html.replaceAll(/<!--[\s\S]*?-->/g, "").matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
    .map(([tag]) => attributesOf(tag))
    .filter(
      (attributes) =>
        attributes.get("http-equiv")?.trim().toLowerCase() === "content-security-policy",
    )
    .map((attributes) => attributes.get("content") ?? "")

/**
 * Whether a policy allows anything by a hash of its text: a script, as the viewer frame's
 * pages do, or a style, which a CRLF checkout breaks the same way.
 */
export const allowsByHash = (policy: string): boolean =>
  policy
    .split(";")
    .flatMap((directive) => directive.trim().split(/\s+/).slice(1))
    .some((source) => hashSource.test(source))

/** Whether a page's text sets a policy that allows anything by hash. */
export const isHashed = (html: string): boolean => policiesOf(html).some(allowsByHash)

/**
 * The pages under `root`'s repository that allow anything by hash, relative to it: every page
 * git tracks or would (untracked but not ignored), so a new one counts before it's committed.
 */
export const hashedPages = (root: string): readonly string[] =>
  execFileSync(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "-z", "-co", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter((path) => pageFile.test(path))
    // A tracked page deleted from the tree is still listed; it has nothing to check out.
    .filter((path) => existsSync(join(root, path)))
    .filter((path) => isHashed(readFileSync(join(root, path), "utf8")))
    .toSorted()

/**
 * The `eol` attribute git checks each of `paths` (relative to `root`) out with, by its
 * `.gitattributes`: `lf` where the page keeps LF on every system, `unspecified` where nothing
 * names it.
 */
export const eolOf = (
  root: string,
  paths: readonly string[],
): readonly { readonly path: string; readonly eol: string }[] => {
  if (paths.length === 0) return []
  // `<path> NUL eol NUL <value> NUL`, once for each path.
  const fields = execFileSync("git", ["check-attr", "-z", "eol", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  }).split("\0")
  const values = new Map<string, string>()
  for (let at = 0; at + 2 < fields.length; at += 3) {
    values.set(fields[at] ?? "", fields[at + 2] ?? "")
  }
  return paths.map((path) => ({ path, eol: values.get(path) ?? "unspecified" }))
}
