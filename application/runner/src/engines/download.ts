import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"

/** Raised for a download that failed, with a message a person can read. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DownloadError"
  }
}

const open = async (from: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> => {
  if (!/^https?:\/\//i.test(from)) return createReadStream(from, { signal })
  let response: Response
  try {
    response = await fetch(from, { signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new DownloadError(`Could not reach ${new URL(from).host}. Check the connection.`)
  }
  if (!response.ok || response.body === null)
    throw new DownloadError(`${new URL(from).host} answered ${response.status}.`)
  // The DOM and Node typings of a web stream disagree; they are the same stream.
  return Readable.fromWeb(response.body as unknown as NodeReadableStream)
}

/**
 * Saves what is at `from`, a URL or a file, as `to` once it hashes to `sha256`. It goes to
 * `to.part` first, so a file that is there is whole, and a download that fails, or comes
 * out wrong or too large, leaves nothing. `progress` hears the bytes received so far.
 */
export const download = async (options: {
  from: string
  to: string
  sha256: string
  /** How many bytes it must be, when known: more than that is not the file, and stops the download. */
  size?: number
  signal: AbortSignal
  progress: (received: number) => void
}): Promise<void> => {
  const { from, to, signal } = options
  const part = `${to}.part`
  await mkdir(dirname(to), { recursive: true })
  const hash = createHash("sha256")
  let received = 0
  try {
    await pipeline(
      await open(from, signal),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          hash.update(chunk)
          received += chunk.length
          if (options.size !== undefined && received > options.size)
            throw new DownloadError("The download is larger than expected. Try again.")
          options.progress(received)
          yield chunk
        }
      },
      createWriteStream(part),
      { signal },
    )
    if (hash.digest("hex") !== options.sha256)
      throw new DownloadError(
        "The download is damaged: its checksum is not the expected one. Try again.",
      )
    await rename(part, to)
  } catch (error) {
    await rm(part, { force: true })
    if (error instanceof DownloadError || signal.aborted) throw error
    throw new DownloadError(
      `The download stopped: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Where a file named `name` is under `source`: a URL ending in `/`, or a directory. */
export const locate = (source: string, name: string): string =>
  /^https?:\/\//i.test(source) ? new URL(encodeURIComponent(name), source).href : join(source, name)
