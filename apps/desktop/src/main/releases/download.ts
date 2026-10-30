import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

/** The whole percent that `received` bytes are of `total`, 0 to 100; undefined with no total. */
export const wholePercent = (received: number, total: number | undefined): number | undefined =>
  total === undefined || !(total > 0)
    ? undefined
    : Math.min(100, Math.max(0, Math.floor((received / total) * 100)))

/**
 * Turns byte counts into whole-percent reports, each told once as it changes. Without a
 * `total` nothing is reported.
 */
export const reportPercents = (
  total: number | undefined,
  report: (percent: number) => void,
): ((received: number) => void) => {
  let last: number | undefined
  return (received) => {
    const percent = wholePercent(received, total)
    if (percent === undefined || percent === last) return
    last = percent
    report(percent)
  }
}

/** The part of a response that downloading uses. */
export type DownloadResponse = {
  readonly ok: boolean
  readonly status: number
  readonly body: AsyncIterable<Uint8Array> | null
}

/** How a download is summed: the hash algorithm and how its digest is written. */
export type Digest = {
  readonly algorithm: "sha256" | "sha512"
  readonly encoding: "hex" | "base64"
}

/** What `latest.yml` lists a file by: the base64 SHA-512. */
export const sha512Base64: Digest = { algorithm: "sha512", encoding: "base64" }

/**
 * Streams a response's body into `write`, hashing it on the way, and stops past `maxBytes`.
 * `received` is told the bytes written so far after each chunk.
 * Returns the `digest` of the body, the base64 SHA-512 `latest.yml` lists unless another
 * is asked for.
 */
export const hashBody = async (
  response: DownloadResponse,
  write: (chunk: Uint8Array) => Promise<void>,
  maxBytes: number,
  received: (total: number) => void = () => {},
  digest: Digest = sha512Base64,
): Promise<string> => {
  if (!response.ok || response.body === null)
    throw new Error(`The download answered ${response.status}.`)
  const hash = createHash(digest.algorithm)
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error("The download is larger than expected.")
    hash.update(chunk)
    await write(chunk)
    received(total)
  }
  return hash.digest(digest.encoding)
}

/**
 * The portable file each system's release carries, named without a version so that
 * `releases/latest/download/<name>` is always the newest stable one and an old portable
 * copy can still find it: the AppImage, and the ZIPs of the unpacked Windows app and of the
 * macOS app bundle.
 */
export const portableAssets = {
  linux: "novadeck-linux-x86_64.AppImage",
  win32: "novadeck-win-x64.zip",
  darwin: "novadeck-mac-universal.zip",
} as const

/** The most bytes a portable file may be; the largest, the macOS ZIP, is a few hundred megabytes. */
const maxPortableBytes = 1 << 30

/** How long a download may go without data before it is given up. */
const downloadStallMs = 60_000

/** The file a release lists its checksums in, as `sha256sum` writes them. */
const checksumsName = "SHA256SUMS"

/**
 * The SHA-256 (lowercase hex) that `sha256sum` output lists for the file `name`, or
 * undefined if it is not listed. A line is the hash, a space, then a space (text) or an
 * asterisk (binary) and the name.
 */
export const checksumOf = (sums: string, name: string): string | undefined => {
  for (const line of sums.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/u.exec(line)
    if (match?.[2] === name) return match[1]?.toLowerCase()
  }
  return undefined
}

/** What the network offers release downloads: the text of an address. */
export type ReleaseText = {
  /**
   * The text of `url`, or undefined when it answers 404; throws on any other failure,
   * including a network error or a status other than 200.
   */
  readonly text: (url: string) => Promise<string | undefined>
  readonly log: (message: string, error: unknown) => void
}

/** A SHA-256 the release lists for a file, or why there is none. */
export type Listed =
  | { readonly kind: "listed"; readonly sha256: string }
  | { readonly kind: "failed"; readonly reason: string }

/**
 * The SHA-256 that the release at `base` (an address ending in "/") lists for `name` in its
 * `SHA256SUMS`. `what` names the file for the person, as "the AppImage". Nothing is
 * downloaded that the release does not vouch for, so a missing list or entry fails.
 */
export const listedChecksum = async (
  { text, log }: ReleaseText,
  base: string,
  name: string,
  what: string,
): Promise<Listed> => {
  let sums: string | undefined
  try {
    sums = await text(`${base}${checksumsName}`)
  } catch (error) {
    log("The release's checksums could not be fetched.", error)
    return {
      kind: "failed",
      reason: "The release could not be fetched. Are you online?",
    }
  }
  if (sums === undefined)
    return {
      kind: "failed",
      reason: `The release has no checksums to check ${what} against.`,
    }
  const sha256 = checksumOf(sums, name)
  return sha256 === undefined
    ? { kind: "failed", reason: `The release does not list ${what}.` }
    : { kind: "listed", sha256 }
}

/**
 * Downloads `url` into `file` and gives the SHA-256 (hex) of what was written, telling
 * `progress` the whole percent along; throws on any failure, removing what it wrote, and
 * gives up past `maxBytes`.
 */
export type Download = (
  url: string,
  file: string,
  maxBytes: number,
  progress: (percent: number) => void,
) => Promise<string>

/** How a checked download went: the file is there and matches, or nothing is kept. */
export type Downloaded =
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly reason: string }

/**
 * Downloads `url` into `file` and keeps it only if it is the `sha256` the release lists; a
 * file that does not match is removed. The person is told so in a sentence that names
 * `what` it was.
 */
export const downloadChecked = async (
  host: {
    readonly download: Download
    readonly remove: (file: string) => Promise<void>
    readonly log: (message: string, error: unknown) => void
  },
  {
    url,
    file,
    sha256,
    what,
    progress,
  }: {
    readonly url: string
    readonly file: string
    readonly sha256: string
    readonly what: string
    readonly progress: (percent: number) => void
  },
): Promise<Downloaded> => {
  let got: string
  try {
    got = await host.download(url, file, maxPortableBytes, progress)
  } catch (error) {
    host.log(`Downloading ${what} failed.`, error)
    await host.remove(file).catch(() => {})
    return {
      kind: "failed",
      reason: `${capitalized(what)} could not be downloaded. Are you online?`,
    }
  }
  if (got !== sha256) {
    await host.remove(file).catch(() => {})
    return {
      kind: "failed",
      reason: `The downloaded ${withoutArticle(what)} did not match the release, so it was discarded.`,
    }
  }
  return { kind: "ready" }
}

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
const withoutArticle = (text: string): string => text.replace(/^(?:the|a|an) /iu, "")

/** A response as downloading uses it: the status, the body to stream and the headers. */
export type Fetched = DownloadResponse & {
  readonly headers: { get(name: string): string | null }
}

/** The part of a file being written that a download uses. */
export type DownloadTarget = {
  write(chunk: Uint8Array): Promise<unknown>
  close(): Promise<void>
}

/**
 * Downloads `url` through `fetch` into the file `open` makes, hashing as it goes with
 * `digest`, and returns the digest. The download is given up only when no data comes for
 * `stallMs`, so a slow link is not cut off; `size` is the byte count the release lists for
 * the file, else the response's own, which whole-percent `progress` is measured against.
 * The file is removed again on any failure.
 */
export const streamToFile = async ({
  url,
  file,
  maxBytes,
  stallMs = downloadStallMs,
  size,
  digest,
  progress,
  fetch,
  open,
  remove,
}: {
  readonly url: string
  readonly file: string
  readonly maxBytes: number
  readonly stallMs?: number
  readonly size?: number | undefined
  readonly digest: Digest
  readonly progress: (percent: number) => void
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Fetched>
  readonly open: (file: string) => Promise<DownloadTarget>
  readonly remove: (file: string) => Promise<void>
}): Promise<string> => {
  const target = await open(file)
  const controller = new AbortController()
  let stall: ReturnType<typeof setTimeout> | undefined
  const alive = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), stallMs)
  }
  alive()
  try {
    const response = await fetch(url, { signal: controller.signal })
    const length = Number(response.headers.get("content-length"))
    const report = reportPercents(size ?? (length > 0 ? length : undefined), progress)
    const sum = await hashBody(
      response,
      async (chunk) => {
        alive()
        await target.write(chunk)
      },
      maxBytes,
      report,
      digest,
    )
    await target.close()
    return sum
  } catch (error) {
    await target.close().catch(() => {})
    await remove(file).catch(() => {})
    throw error
  } finally {
    clearTimeout(stall)
  }
}

/** The SHA-256 (hex) of the file at `file`. */
export const hashFile = async (file: string): Promise<string> => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}
