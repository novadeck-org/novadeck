import { createHmac } from "node:crypto"

/** What `hashPaths` needs to know of this machine. */
export type PathRule = {
  /** The person's home folder, written `~`. */
  readonly home?: string
  /** The person's account name, written `<user>` where it names a folder. */
  readonly user?: string
  /**
   * The app's own folders, by the name each is written as (`userData` becomes `<userData>`):
   * what is under them stays readable.
   */
  readonly places?: Readonly<Record<string, string>>
  /**
   * The app's folders that hold the person's own files, as pasted files are kept under
   * their names: written as their placeholders (`<uploads>`), but what is under them hashed.
   */
  readonly privatePlaces?: Readonly<Record<string, string>>
  /** Keys the hash, so a name can't be found by hashing likely ones; never logged. */
  readonly salt: string
  /**
   * Names never hashed, in any path, besides `readableNames`: the app's own programs and
   * folders, which carry nothing of the person's. Compared lowercased, without `.exe`.
   */
  readonly readable?: readonly string[]
}

/**
 * Names that stay readable in any path: well-known programs and the folders tools keep, which
 * say which program failed and carry nothing of the person's. Code, not configuration, so a
 * change to it is reviewed as code is.
 */
export const readableNames: readonly string[] = [
  "node",
  "git",
  "bash",
  "zsh",
  "fish",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
  "bin",
  "lib",
  "share",
  "versions",
  ".local",
  ".config",
  ".cache",
  ".nvm",
  ".volta",
  ".bun",
  ".cargo",
  ".npm-global",
  "appdata",
  "local",
  "roaming",
  "programs",
]

/**
 * Hashes one name, keeping its extension and a stack frame's `:line:column`, as `hashPaths`
 * does each name of a path; `lower` hashes it lowercased, as Windows matches names. A name it
 * wrote, a readable one, a version number and the account's (`<user>`) are written as they are.
 */
export const nameHasher = (rule: PathRule): ((named: string, lower: boolean) => string) => {
  const user = rule.user?.toLowerCase()
  const readable = new Set(
    [...readableNames, ...(rule.readable ?? [])].map((each) => each.toLowerCase()),
  )
  return (named, lower) => {
    const position = /(?::\d+)+$/.exec(named)?.[0] ?? ""
    const segment = position ? named.slice(0, -position.length) : named
    if (/^#[0-9a-f]{8}(?:\.|$)/.test(segment)) return named
    const plain = segment.toLowerCase().replace(/\.exe$/, "")
    if (readable.has(plain) || /^v?\d+(?:\.\d+)*$/.test(segment)) return named
    if (user && segment.toLowerCase() === user) return `<user>${position}`
    const dot = segment.lastIndexOf(".")
    const extension =
      dot > 0 && /^\.[A-Za-z0-9]{1,10}$/.test(segment.slice(dot)) ? segment.slice(dot) : ""
    const base = extension ? segment.slice(0, -extension.length) : segment
    const digest = createHmac("sha256", rule.salt)
      .update(lower ? base.toLowerCase() : base)
      .digest("hex")
    return `#${digest.slice(0, 8)}${extension}${position}`
  }
}

// What a folder or file name may hold, as found in free text: no separator, space, quote,
// bracket, or `:`, which starts a stack frame's `:line:column`.
const name = String.raw`[^\s\\/"'\x60()<>\[\]{}|,;:*?]+`
// A name with spaces counts as one where a separator follows it (`My Project/`), or where
// its last word ends in an extension (`Client Acme Plan.md`).
const pathSegment =
  String.raw`(?:Program Files \(x86\)|${name}(?: (?!~)${name})+(?=[\\/])|` +
  String.raw`(?:${name} (?!~))+[^\s\\/"'\x60()<>\[\]{}|,;:*?]*\.[A-Za-z0-9]{1,10}(?![\w.])|${name})`
const separator = String.raw`[\\/]+`

/**
 * A path in free text: from a drive (`C:\`), a share (`\\server\`), home (`~/`), a
 * placeholder already written (`<userData>/`) or the root (`/`), or a `file://` address of
 * one; never in the middle of a word, nor an address of another kind (`https://host/a`).
 */
const roots = String.raw`(?<root>(?<=file://)/[A-Za-z]:(?=/)|[A-Za-z]:(?=[\\/])|\\\\(?=[^\\\s])|~(?=[\\/])|<[A-Za-z][\w-]*>(?=[\\/])|(?=/))`
const pathPattern = new RegExp(
  String.raw`(?<![\w.~\-\\/<>#])(?!(?<=[A-Za-z][\w+.-]*:)//)(?<file>file://)?${roots}` +
    String.raw`(?<rest>[\\/]*${pathSegment}(?:${separator}${pathSegment})*)`,
  "g",
)

/**
 * A path in quotes, as Node's errors write one (`open '/x/My File.md'`): taken whole, up to
 * its closing quote, so a name with spaces is hashed whole.
 */
const quotedPattern = new RegExp(
  String.raw`(?<=(?<quote>['"\x60]))(?<file>file://)?${roots}(?<rest>[^'"\x60\n]+?)(?=\k<quote>)`,
  "g",
)

// Where everything stays readable: the system's own folders.
const systemRoots = new Set([
  "usr",
  "proc",
  "sys",
  "dev",
  "bin",
  "sbin",
  "lib",
  "lib32",
  "lib64",
  "libx32",
  "etc",
  "nix",
  "snap",
  "run",
  "System",
  "Library",
  "Applications",
])
// Where only the first folder stays readable, as what is under it is anyone's.
const sharedRoots = new Set([
  "opt",
  "home",
  "Users",
  "tmp",
  "var",
  "private",
  "mnt",
  "media",
  "Volumes",
  "root",
  "srv",
])
const windowsSystemRoots = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
])
const windowsSharedRoots = new Set(["users"])
const wslShares = new Set(["wsl$", "wsl.localhost"])

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

const windowsShaped = (path: string): boolean => /^(?:[A-Za-z]:|\\\\)/.test(path)

/** Finds `folder` in text, with either separator, and not as the start of a longer name. */
const folderPattern = (folder: string): RegExp => {
  // A leading separator is one, so `file:///home/ana` keeps its address's own two.
  const [first = "", ...rest] = folder.split(/[\\/]+/).map(escape)
  const body =
    first === "" ? String.raw`[\\/]${rest.join(separator)}` : [first, ...rest].join(separator)
  return new RegExp(String.raw`(?<![\w.\-~])${body}(?![\w.\-])`, windowsShaped(folder) ? "gi" : "g")
}

/**
 * Hashes the names in paths, so a log names no project, folder or file of the person's:
 * `/home/ana/acme/billing.ts` becomes `~/#1f2e3d4c/#9a8b7c6d.ts`. The same name hashes the
 * same wherever it appears on one install, as the hash is keyed with its salt, and a name
 * keeps its extension.
 *
 * Readable as they are: the app's own folders, written as their placeholders (`<userData>`),
 * and what is under them; the system's folders (`/usr`, `C:\Windows`, `/Applications`);
 * the first folder of a shared root (`/tmp`, `/home`, `C:\Users`); a WSL share and its
 * distribution; and everything inside `node_modules`. Home is written `~`, and a folder named
 * as the person's account `<user>`.
 */
export const hashPaths = (text: string, rule: PathRule): string => {
  const hidden = new Set(Object.keys(rule.privatePlaces ?? {}))
  const places = Object.entries({ ...rule.places, ...rule.privatePlaces })
    .filter(([, folder]) => folder.length > 1)
    .toSorted(([, a], [, b]) => b.length - a.length)
  // Windows' long-path prefix names the same path: `\\?\C:\x` is `C:\x`, `\\?\UNC\s\x` is `\\s\x`.
  let result = text.replace(/\\\\\?\\UNC\\/gi, "\\\\").replace(/\\\\\?\\(?=[A-Za-z]:[\\/])/g, "")
  for (const [placeholder, folder] of places)
    result = result.replace(folderPattern(folder), `<${placeholder}>`)
  if (rule.home && rule.home.length > 1) result = result.replace(folderPattern(rule.home), "~")

  // Windows names are hashed lowercased, as Windows matches them, home's included.
  const homeLower = rule.home !== undefined && windowsShaped(rule.home)
  const hash = nameHasher(rule)
  // Each name hashed from `from` on, but what is inside node_modules.
  const hashFrom = (segments: string[], from: number, lower: boolean): string[] => {
    const modules = segments.findIndex(
      (segment, index) => index >= from && segment === "node_modules",
    )
    return segments.map((segment, index) =>
      index < from || (modules !== -1 && index >= modules) ? segment : hash(segment, lower),
    )
  }
  const posix = (segments: string[], from: number): string[] => {
    const first = segments[from]
    if (first === undefined) return segments
    // An AppImage's mount: the app's own files, under a name that changes every launch.
    if (first === "tmp" && segments[from + 1]?.startsWith(".mount_")) return segments
    if (first === "mnt" && /^[a-z]$/i.test(segments[from + 1] ?? ""))
      return windows(segments, from + 2)
    if (systemRoots.has(first)) return segments
    return hashFrom(segments, sharedRoots.has(first) ? from + 1 : from, false)
  }
  const windows = (segments: string[], from: number): string[] => {
    const first = segments[from]?.toLowerCase()
    if (first === undefined) return segments
    if (windowsSystemRoots.has(first)) return segments
    return hashFrom(segments, windowsSharedRoots.has(first) ? from + 1 : from, true)
  }

  const rewrite = (match: string, ...args: unknown[]): string => {
    const { file = "", root, rest } = args.at(-1) as { file?: string; root: string; rest: string }
    // Separators are kept as they were: the names sit between them.
    const parts = rest.split(/([\\/]+)/)
    const segments = parts.filter((_, index) => index % 2 === 0)
    const separators = parts.filter((_, index) => index % 2 === 1)
    const leading = segments[0] === "" ? 1 : 0
    const named = root.startsWith("<")
      ? hidden.has(root.slice(1, -1))
        ? hashFrom(segments, leading, false)
        : segments
      : root === "~"
        ? hashFrom(segments, leading, homeLower)
        : root === "\\\\"
          ? wslShares.has(segments[0]?.toLowerCase() ?? "")
            ? posix(segments, 2)
            : hashFrom(segments, 0, true)
          : root === ""
            ? posix(segments, leading)
            : windows(segments, leading)
    if (named === segments) return match
    return (
      file + root + named.flatMap((segment, index) => [segment, separators[index] ?? ""]).join("")
    )
  }
  return result.replace(quotedPattern, rewrite).replace(pathPattern, rewrite)
}
