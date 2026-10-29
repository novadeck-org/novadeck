// The connect-src sources of these apps, with nothing of Vite: an app's policy reads them
// where its build runs and where its tests do.

/** A URL the app is configured with, and the setting that names it, for its errors. */
export type ConfiguredUrl = { readonly url: string | undefined; readonly name: string }

type SetUrl = ConfiguredUrl & { readonly url: string }

// A setting with a URL in it, trimmed; none for a setting left out or blank.
const configured = (setting: ConfiguredUrl | undefined): SetUrl | undefined => {
  const url = setting?.url?.trim()
  return setting && url ? { ...setting, url } : undefined
}

// The origin of a runner a browser build connects to, which must be a WebSocket URL.
const webSocketOrigin = ({ url, name }: SetUrl): string => {
  const parsed = URL.parse(url)
  if (parsed?.protocol === "ws:" || parsed?.protocol === "wss:") return parsed.origin
  throw new Error(`${name} must be an absolute ws: or wss: URL`)
}

// A path the page's own origin serves, which no scheme-relative or backslash form escapes.
const relativeBase = new URL("https://build-kit.invalid")
const isRelativePath = (url: string): boolean =>
  (url.startsWith("/") || url.startsWith("./")) &&
  new URL(url, relativeBase).origin === relativeBase.origin

// The origin of an API a build talks to over HTTP(S); none for one on loopback, which every
// app allows already, or at a relative path, which is the page's own origin.
const apiOrigin = ({ url, name }: SetUrl): string | undefined => {
  const parsed = URL.parse(url)
  if (parsed?.protocol === "http:" || parsed?.protocol === "https:") {
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1"
      ? undefined
      : parsed.origin
  }
  if (isRelativePath(url)) return undefined
  throw new Error(`${name} must be an absolute HTTP(S) URL or a relative path`)
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

  const runner = configured(options.runner)
  if (runner) sources.add(webSocketOrigin(runner))

  const api = configured(options.api)
  const origin = api && apiOrigin(api)
  if (origin) sources.add(origin)

  return [...sources]
}
