// The connect-src sources of these apps, with nothing of Vite: an app's policy reads them
// where its build runs and where its tests do.

/** A URL the app is configured with, and the setting that names it, for its errors. */
export type ConfiguredUrl = { readonly url: string | undefined; readonly name: string }

// The origin of a runner a browser build connects to, which must be a WebSocket URL.
const webSocketOrigin = ({ url, name }: ConfiguredUrl & { url: string }): string => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return parsed.origin
  } catch {
    // Reported below.
  }
  throw new Error(`${name} must be an absolute ws: or wss: URL`)
}

/**
 * The connect-src sources of an app that talks to services on loopback, and, where
 * configured, to an HTTP(S) API and a WebSocket runner elsewhere. While served, the
 * development server's WebSocket on loopback too.
 */
export const connectSources = (options: {
  readonly api?: ConfiguredUrl
  readonly runner?: ConfiguredUrl
  readonly development: boolean
}): readonly string[] => {
  const sources = new Set(["'self'", "http://127.0.0.1:*"])

  if (options.development) sources.add("ws://127.0.0.1:*")

  const runner = options.runner?.url?.trim()
  if (runner && options.runner) sources.add(webSocketOrigin({ ...options.runner, url: runner }))

  const api = options.api?.url?.trim()
  if (!api || !options.api) return [...sources]

  try {
    const url = new URL(api)

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol")
    }

    if (!(url.protocol === "http:" && url.hostname === "127.0.0.1")) sources.add(url.origin)
  } catch {
    const base = new URL("https://build-kit.invalid")
    const hasRelativePrefix = api.startsWith("/") || api.startsWith("./")
    const isRelativePath = hasRelativePrefix && new URL(api, base).origin === base.origin

    if (!isRelativePath) {
      throw new Error(`${options.api.name} must be an absolute HTTP(S) URL or a relative path`)
    }
  }

  return [...sources]
}
