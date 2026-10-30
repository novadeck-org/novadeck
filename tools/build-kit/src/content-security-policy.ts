import { loadEnv, type ConfigEnv, type Plugin } from "vite"

/** A build, as the app's policy sees it: its mode, whether it's served, and its environment. */
export type Build = {
  readonly mode: string
  readonly command: ConfigEnv["command"]
  /** The environment's variables with the app's prefix, from the process or its env files. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * Fills the connect-src of the page's Content Security Policy: `placeholder` in its
 * index.html becomes the sources `connect` gives for the build. A page without the
 * placeholder fails the build, so a policy can't silently go unfilled.
 */
export const contentSecurityPolicy = (options: {
  readonly placeholder: string
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
      if (!html.includes(options.placeholder)) {
        throw new Error("Content Security Policy connect-src placeholder is missing")
      }
      return html.replace(options.placeholder, options.connect(build).join(" "))
    },
  }
}
