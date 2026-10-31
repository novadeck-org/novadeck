// The connect-src sources of these apps, with nothing of Vite: an app's policy reads them
// where its build runs and where its tests do.

/** A URL the app is configured with, and the setting that names it, for its errors. */
export type ConfiguredUrl = { readonly url: string | undefined; readonly name: string }

// The origin of a runner a browser build connects to, which must be a WebSocket URL; none
// for a setting left out or blank.
const webSocketOrigin = (setting: ConfiguredUrl | undefined): string | undefined => {
  const url = setting?.url?.trim()
  if (!setting || !url) return undefined
  const parsed = URL.parse(url)
  if (parsed?.protocol === "ws:" || parsed?.protocol === "wss:") return parsed.origin
  throw new Error(`${setting.name} must be an absolute ws: or wss: URL`)
}

/**
 * The connect-src sources of an app that talks to services on loopback, and, where
 * configured, to a WebSocket runner elsewhere. While served, the development server's
 * WebSocket on loopback too.
 */
export const connectSources = (options: {
  readonly runner?: ConfiguredUrl
  readonly development: boolean
}): readonly string[] => {
  const sources = new Set(["'self'", "http://127.0.0.1:*"])
  if (options.development) sources.add("ws://127.0.0.1:*")
  const runner = webSocketOrigin(options.runner)
  if (runner) sources.add(runner)
  return [...sources]
}

/**
 * What a build reaches as it is configured: the runner `VITE_NOVADECK_RUNNER_URL` names, the
 * one a browser build connects to, and while served, the development server.
 */
export const configuredSources = (build: {
  readonly command: string
  readonly env: Readonly<Record<string, string | undefined>>
}): readonly string[] =>
  connectSources({
    runner: { url: build.env.VITE_NOVADECK_RUNNER_URL, name: "VITE_NOVADECK_RUNNER_URL" },
    development: build.command === "serve",
  })
