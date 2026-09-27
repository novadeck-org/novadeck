// The origin of the runner a browser build connects to, which must be a WebSocket URL.
const runnerOrigin = (runnerUrl: string): string => {
  try {
    const url = new URL(runnerUrl)
    if (url.protocol === "ws:" || url.protocol === "wss:") return url.origin
  } catch {
    // Reported below.
  }
  throw new Error("VITE_NOVADECK_RUNNER_URL must be an absolute ws: or wss: URL")
}

export const contentSecurityPolicyConnectSources = (
  apiUrl: string | undefined,
  development: boolean,
  runnerUrl?: string | undefined,
): readonly string[] => {
  const sources = new Set(["'self'", "http://127.0.0.1:*"])

  if (development) sources.add("ws://127.0.0.1:*")

  const configuredRunner = runnerUrl?.trim()
  if (configuredRunner) sources.add(runnerOrigin(configuredRunner))

  const configuredUrl = apiUrl?.trim()
  if (!configuredUrl) return [...sources]

  try {
    const url = new URL(configuredUrl)

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol")
    }

    if (!(url.protocol === "http:" && url.hostname === "127.0.0.1")) sources.add(url.origin)
  } catch {
    const base = new URL("https://novadeck.invalid")
    const hasRelativePrefix = configuredUrl.startsWith("/") || configuredUrl.startsWith("./")
    const isRelativePath = hasRelativePrefix && new URL(configuredUrl, base).origin === base.origin

    if (!isRelativePath) {
      throw new Error("VITE_API_URL must be an absolute HTTP(S) URL or a relative path")
    }
  }

  return [...sources]
}
