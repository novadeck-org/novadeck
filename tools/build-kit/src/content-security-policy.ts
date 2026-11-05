import { loadEnv, type ConfigEnv, type Plugin } from "vite"

/** A build, as the app's policy sees it: its mode, whether it's served, and its environment. */
export type Build = {
  readonly mode: string
  readonly command: ConfigEnv["command"]
  /** The environment's variables with the app's prefix, from the process or its env files. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** What the connect-src of every app's index.html holds until a build fills it. */
export const connectSourcesPlaceholder = "__NOVADECK_CONNECT_SOURCES__"

/**
 * Fills the connect-src of the page's Content Security Policy: every placeholder in its
 * index.html becomes the sources `connect` gives for the build, as they are. A page without
 * the placeholder fails the build, as does one that still holds it once filled, so a policy
 * can't silently go unfilled.
 */
export const contentSecurityPolicy = (options: {
  readonly connect: (build: Build) => readonly string[]
  /** The prefix of the variables the policy reads; the app's `envPrefix`, by default. */
  readonly envPrefix?: string | readonly string[]
}): Plugin => {
  let build: Build
  return {
    name: "build-kit-content-security-policy",
    configResolved(config) {
      const prefixes = [options.envPrefix ?? config.envPrefix ?? "VITE_"].flat()
      if (prefixes.includes("")) {
        throw new Error("The Content Security Policy's envPrefix can't be empty")
      }
      // The env files the app's own build reads, with the process's variables before them.
      build = {
        mode: config.mode,
        command: config.command,
        env: loadEnv(config.mode, config.envDir, prefixes),
      }
    },
    transformIndexHtml(html) {
      if (!html.includes(connectSourcesPlaceholder)) {
        throw new Error("Content Security Policy connect-src placeholder is missing")
      }
      const sources = options.connect(build).join(" ")
      // A function, so a source is put in as it is: a string would expand its `$&` and `$'`.
      const filled = html.replaceAll(connectSourcesPlaceholder, () => sources)
      if (filled.includes(connectSourcesPlaceholder)) {
        throw new Error("Content Security Policy connect-src placeholder is left unfilled")
      }
      return filled
    },
  }
}
