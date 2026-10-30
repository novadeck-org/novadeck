// What murmur's and voice's installs of an engine share: how a failure reads to the person,
// how often progress is shown, and how soon a failed update is tried again.
import { DownloadError } from "./download.js"
import { EngineError } from "./unpack.js"

/** How often install progress reaches watchers, at most. */
export const progressMs = 100

/**
 * How long after a failed engine update the next use tries it again, as when the network
 * was down: soon enough to recover by itself, not on every use.
 */
export const updateRetryMs = 60_000

/** Why installing `product` ("murmur", "voice input") failed, in words for the person. */
export const explainInstall = (error: unknown, product: string): string => {
  if (error instanceof DownloadError || error instanceof EngineError) return error.message
  if (error instanceof Error && "code" in error && error.code === "ENOSPC")
    return `There is not enough disk space to install ${product}.`
  return `${product.charAt(0).toUpperCase()}${product.slice(1)} could not be installed: ${error instanceof Error ? error.message : String(error)}`
}
