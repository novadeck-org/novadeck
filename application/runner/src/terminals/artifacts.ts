import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path"

import type { ArtifactContent, ShownArtifact } from "@novadeck/protocol"
import { z } from "zod"

/**
 * What an agent asks to show, through NovaDeck's MCP server: a file by its path, absolute
 * or from the terminal's directory; for a text file, the lines it points at; a title in
 * place of the file's name; and `open` when the person asked to see it.
 */
// What either request takes: a short name to show, and whether the person asked to see it.
const shared = { title: z.string().min(1).max(256).optional(), open: z.boolean().optional() }

/** A file to show, by its path, and the lines to point at. */
export const fileRequest = z.strictObject({
  path: z.string().min(1).max(4096),
  lines: z
    .strictObject({ from: z.int().min(1), to: z.int().min(1) })
    .refine(({ from, to }) => to >= from)
    .optional(),
  ...shared,
})

// What the protocol takes of a page's address.
const maxUrlChars = 8192

/** A page to show, by its http(s) address. */
export const pageRequest = z.strictObject({ url: z.string().min(1).max(maxUrlChars), ...shared })

export type FileRequest = z.infer<typeof fileRequest>
export type PageRequest = z.infer<typeof pageRequest>
export type PresentRequest = FileRequest | PageRequest

/** Why it was not shown, in a sentence the agent can act on. */
export type PresentFailure = { readonly ok: false; readonly reason: string }

/**
 * The MCP server's answer: what the person now sees, or why not. `opened` when it opened
 * at once; `held` when it may hold secrets, so it waits for the person to open it.
 */
export type PresentAnswer =
  | {
      readonly ok: true
      readonly id: string
      readonly kind: ShownArtifact["kind"]
      readonly name: string
      readonly opened: boolean
      readonly held?: true
    }
  | PresentFailure

/** Something an agent showed, as the person sees it listed and as it was captured. */
export type Artifact = { readonly shown: ShownArtifact; readonly content: ArtifactContent }

/** What was read of a request, before it is shown. */
export type Captured = {
  readonly ok: true
  readonly id: string
  readonly name: string
  readonly detail: string
  readonly content: ArtifactContent
  /** A file that may hold secrets: it never opens by itself, only when the person opens it. */
  readonly held?: true
}

/** Where a present happens: the terminal's directory, and its project, which names files. */
export type Place = {
  readonly cwd: string
  readonly project: string | undefined
}

// What is shown as an image, by extension.
const images: { readonly [extension: string]: string } = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
}
const maxImageBytes = 8 * 1024 * 1024
const maxTextBytes = 1024 * 1024
// A text file has no NUL byte in this much of its start.
const sniffBytes = 8 * 1024
// A file this long is captured whole; a longer one, around what was pointed at.
const wholeLines = 400
const contextLines = 40
// What the protocol takes of a file.
const maxLines = 2000
const maxLineChars = 4096
/** The most a terminal keeps shown; the oldest go first. */
export const maxShown = 64
/** The most a terminal keeps of what it showed, in bytes of content; the oldest go first. */
export const maxShownBytes = 48 * 1024 * 1024

// Files that often hold secrets: a key, credentials, an environment file, an agent's or a
// tool's login, a shell's history. NovaDeck shows them, as any file the person can
// read, but never puts one on screen by itself, as while the person shares it.
const secretFolders = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"])
const secretNames = [
  /^\.env(\..*)?$/i,
  /\.env$/i,
  /^\.envrc$/i,
  /^\.?credentials(\.[\w.]+)?$/i,
  /^oauth_creds\.json$/i,
  /^\.yarnrc\.yml$/i,
  /^\.s3cfg$/i,
  /^rclone\.conf$/i,
  /^fish_history$/i,
  /^\.vault-token$/i,
  /^\.dockercfg$/i,
  /^kubeconfig$/i,
  /^\.[\w-]*_history$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^secrets?\.(json|ya?ml|toml|ini|env|txt|properties)$/i,
  /^service-account.*\.json$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_[^.]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|tfstate)$/i,
]
// Where tools keep their logins under names too plain to hold everywhere: the GitHub
// CLI's hosts.yml (in "GitHub CLI" on Windows), Codex's auth.json, and gcloud's folder.
const secretPaths = [
  /[\\/](gh|GitHub CLI)[\\/]hosts\.ya?ml$/i,
  /[\\/]\.codex[\\/]auth\.json$/i,
  /[\\/](\.config|AppData[\\/]Roaming)[\\/]gcloud[\\/]/i,
]
const secret = (path: string): boolean =>
  path.split(sep).some((part) => secretFolders.has(part)) ||
  secretNames.some((name) => name.test(basename(path))) ||
  secretPaths.some((pattern) => pattern.test(path))

const failure = (reason: string): PresentFailure => ({ ok: false, reason })

/** The request, or why it cannot be one. */
export const readRequest = (
  value: unknown,
): { readonly ok: true; readonly request: PresentRequest } | PresentFailure => {
  // A page by its url, otherwise a file; each read strictly, so it names what's wrong.
  const page = typeof value === "object" && value !== null && "url" in value
  if (page && "path" in value) return failure("Give a path or a url, not both.")
  if (typeof value === "object" && value !== null && !page && !("path" in value))
    return failure("Give a path or a url.")
  const parsed = (page ? pageRequest : fileRequest).safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  const [issue] = parsed.error.issues
  const field = issue?.path.join(".")
  return failure(field ? `The request's "${field}" is not valid.` : "The request is not valid.")
}

/** Whether `path` lies inside `folder`; both resolved alike. */
const inside = (folder: string, path: string): boolean => {
  const route = relative(folder, path)
  return route !== "" && !isAbsolute(route) && route.split(sep)[0] !== ".."
}

const real = (path: string): Promise<string | undefined> => realpath(path).catch(() => undefined)

/** A stable id for what was shown from one terminal, by the file it resolved to. */
const idOf = (path: string): string =>
  createHash("sha256").update(path).digest("base64url").slice(0, 16)

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - max + 1)}`

const size = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Roughly what content takes in memory. */
export const bytesOf = (content: ArtifactContent): number =>
  content.kind === "image"
    ? content.src.length
    : content.kind === "page"
      ? content.url.length
      : content.lines.reduce((total, line) => total + line.length, 0)

/**
 * The lines of a file of `total` lines captured, from `first` to `last`, and the ones
 * pointed at, `from` to `to`: every line of a short file; around `lines` in a longer
 * one, with some context each side; or its start. Undefined when `lines` starts past
 * the end.
 */
export const captureWindow = (
  total: number,
  lines: FileRequest["lines"],
): { first: number; last: number; from: number; to: number } | undefined => {
  if (lines && lines.from > total) return undefined
  if (total <= wholeLines)
    return {
      first: 1,
      last: total,
      from: lines?.from ?? 1,
      to: Math.min(lines?.to ?? total, total),
    }
  if (!lines) return { first: 1, last: wholeLines, from: 1, to: wholeLines }
  const first = Math.max(1, lines.from - contextLines)
  const last = Math.min(total, lines.to + contextLines, first + maxLines - 1)
  return { first, last, from: lines.from, to: Math.min(lines.to, last) }
}

/**
 * A page, by its address: any http(s) page, which the desktop app loads in its own
 * locked-down browser view. An address carrying a user name or password is refused,
 * as it would show them.
 */
const capturePage = (request: PageRequest): Captured | PresentFailure => {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return failure("That isn't a valid address.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return failure("NovaDeck shows only http and https pages.")
  if (url.username || url.password)
    return failure("NovaDeck won't show an address with a user name or password in it.")
  // Encoding can lengthen it past what the protocol carries.
  if (url.href.length > maxUrlChars) return failure("That address is too long.")
  return {
    ok: true,
    id: idOf(url.href),
    name: request.title ?? url.host,
    detail: clip(url.href, 512),
    content: { kind: "page", url: url.href },
  }
}

/**
 * Reads what a request points at, when it may be shown: a page by its address, or any
 * file the person can read, symlinks resolved, as an image or a text file within their
 * limits; one that may hold secrets is held.
 */
export const capture = async (
  request: PresentRequest,
  place: Place,
): Promise<Captured | PresentFailure> =>
  "url" in request ? capturePage(request) : captureFile(request, place)

const captureFile = async (
  request: FileRequest,
  place: Place,
): Promise<Captured | PresentFailure> => {
  const given = resolve(place.cwd, request.path)
  const path = await real(given)
  if (!path) return failure("That file doesn't exist.")
  // Before opening it, which Windows can't do for a folder.
  if ((await stat(path).catch(() => undefined))?.isDirectory())
    return failure("That's a folder; only files can be shown.")
  const mime = images[extname(path).toLowerCase()]
  const limit = mime ? maxImageBytes : maxTextBytes
  let bytes: Buffer
  try {
    // A pipe or device put in a file's place never blocks the reader, and a symlink put
    // there since it was resolved isn't followed.
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const stats = await handle.stat()
      if (stats.isDirectory()) return failure("That's a folder; only files can be shown.")
      if (!stats.isFile()) return failure("Only images and text files can be shown.")
      const tooLarge = failure(`It's too large to show (limit ${limit / 1024 / 1024} MB).`)
      if (stats.size > limit) return tooLarge
      // To its end, not only its reported size, which a file in /proc gives as 0; one
      // byte past the limit tells it's too large.
      const buffer = Buffer.alloc(stats.size > 0 ? stats.size + 1 : limit + 1)
      let read = 0
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- One chunk after another.
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
        read += bytesRead
        if (read > limit) return tooLarge
        // Its end, or as much as it reported and a byte more, should it have grown.
        if (bytesRead === 0 || read === buffer.length) break
      }
      bytes = buffer.subarray(0, read)
    } finally {
      await handle.close()
    }
  } catch {
    return failure("NovaDeck couldn't read that file.")
  }
  const id = idOf(path)
  const held = secret(path) ? ({ held: true } as const) : {}
  // A held file goes by its own name, so the person sees what they would open.
  const name = clip(held.held ? basename(path) : (request.title ?? basename(given)), 256)
  if (mime) {
    const format = extname(path).slice(1).toUpperCase().replace("JPG", "JPEG")
    return {
      ok: true,
      id,
      content: { kind: "image", src: `data:${mime};base64,${bytes.toString("base64")}` },
      detail: `${size(bytes.length)} ${format}`,
      name,
      ...held,
    }
  }
  if (bytes.subarray(0, sniffBytes).includes(0))
    return failure("Only images and text files can be shown.")
  const all = bytes.toString("utf8").split(/\r\n|\r|\n/)
  // The line a final newline ends is the last one.
  if (all.length > 1 && all.at(-1) === "") all.pop()
  const window = captureWindow(all.length, request.lines)
  if (!window) return failure(`It has only ${all.length} lines.`)
  const project = place.project === undefined ? undefined : await real(place.project)
  const shownPath = project && inside(project, path) ? relative(project, path) : request.path
  const range =
    !request.lines && window.last === all.length
      ? "whole file"
      : `lines ${window.from}–${window.to}`
  return {
    ok: true,
    id,
    content: {
      kind: "file",
      path: clip(path, 4096),
      firstLine: window.first,
      lines: all.slice(window.first - 1, window.last).map((line) => line.slice(0, maxLineChars)),
      from: window.from,
      to: window.to,
    },
    detail: `${clip(shownPath, 512 - range.length - 3)} · ${range}`,
    name,
    ...held,
  }
}

/**
 * What a terminal shows once `captured` is shown too, oldest first: shown again, it
 * replaces what was captured before, with a later version, and becomes the newest.
 * Beyond `maxShown`, or `maxShownBytes` of content, the oldest go.
 */
export const remember = (
  shown: ReadonlyMap<string, Artifact>,
  captured: Captured,
  asked: boolean,
): Map<string, Artifact> => {
  const { id, name, detail, content } = captured
  const version = (shown.get(id)?.shown.version ?? 0) + 1
  const next = new Map(shown)
  next.delete(id)
  const held = captured.held && { held: true }
  next.set(id, {
    shown: { id, kind: content.kind, name, detail, version, asked, ...held },
    content,
  })
  let bytes = 0
  for (const each of next.values()) bytes += bytesOf(each.content)
  // The newest always stays.
  for (const [oldest, each] of next) {
    if ((next.size <= maxShown && bytes <= maxShownBytes) || oldest === id) break
    next.delete(oldest)
    bytes -= bytesOf(each.content)
  }
  return next
}
