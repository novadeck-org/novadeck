import { inject } from "vitest"

// The system the app believes it runs on, which a spec project can set (vitest.config.ts).
//
// The app tells a Mac from the others by `navigator.platform` (frontend/ui's shortcuts, the
// terminal's paste and links, the plan editor), and so do the libraries under it: xterm and
// CodeMirror read it once, as their modules load, and Ark UI's zag reads
// `navigator.userAgentData.platform` first. So the platform is set here, before any of those
// modules loads: this module is the projects' first setup file, ahead of the app. A spec can't switch it
// partway through a file, as the modules that read it at load would keep the first answer and
// the app would run as no real system does.
//
// What this can't change is the browser itself: Chromium's own editing keys and rendering stay
// those of the system it runs on. A spec of the app's own chords and labels runs as it would
// on that system; the nightly run on each system covers the browser's part.

/** A system the specs can run the app as: a Mac, or Linux, which stands for the others. */
export type Platform = "mac" | "linux"

declare module "vitest" {
  // eslint-disable-next-line typescript/consistent-type-definitions -- Only an interface merges with vitest's.
  export interface ProvidedContext {
    /** The system this project runs the app as; unset, the browser's own. */
    platform: Platform | undefined
    /** The spec files that run as each system, relative to the package (vitest.config.ts). */
    eachPlatform: readonly string[]
  }
}

// What each system's Chromium reports, as of Chromium 140.
const reported: Record<Platform, { platform: string; agent: string; os: string }> = {
  mac: { platform: "MacIntel", agent: "Macintosh; Intel Mac OS X 10_15_7", os: "macOS" },
  linux: { platform: "Linux x86_64", agent: "X11; Linux x86_64", os: "Linux" },
}

const define = (key: string, value: unknown): void => {
  Object.defineProperty(navigator, key, { configurable: true, get: () => value })
}

const pin = (platform: Platform): void => {
  const { platform: name, agent, os } = reported[platform]
  // The system part of the user agent, the first parenthesis: "(X11; Linux x86_64)".
  const userAgent = navigator.userAgent.replace(/\([^)]*\)/, `(${agent})`)
  define("platform", name)
  define("userAgent", userAgent)
  define("appVersion", userAgent.replace(/^Mozilla\//, ""))
  const data = (navigator as { userAgentData?: AgentData }).userAgentData
  // The rest of what it says (brands, mobile) is the browser's own.
  if (data)
    define("userAgentData", {
      brands: data.brands,
      mobile: data.mobile,
      platform: os,
      getHighEntropyValues: async (hints: string[]) => ({
        ...(await data.getHighEntropyValues(hints)),
        platform: os,
      }),
      toJSON: () => ({ ...data.toJSON(), platform: os }),
    } satisfies AgentData)
}

// `navigator.userAgentData`, which TypeScript's DOM types lack.
type AgentData = {
  readonly brands: unknown
  readonly mobile: boolean
  readonly platform: string
  getHighEntropyValues(hints: string[]): Promise<object>
  toJSON(): object
}

let read = false

/** Whether this file's specs have asked which system the app runs as (`isMac()`). */
export const platformRead = (): boolean => read

/** Notes that a spec asked which system the app runs as. */
export const notePlatformRead = (): void => {
  read = true
}

const platform = inject("platform")
if (platform) pin(platform)
