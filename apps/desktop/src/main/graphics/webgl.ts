import { webglContextsRange } from "@novadeck/protocol/bridge"

import { webglContextsArgumentPrefix } from "../../bridge.js"

// Chromium keeps 16 live WebGL contexts per renderer process and loses the oldest when more
// are asked for, which capped the page's pool at 14 terminals on WebGL (see @novadeck/emulator's
// `rendererPoolCap`). A context costs about 1 MB in the GPU process and 1.6 MB in the renderer
// (architecture/performance.md, "WebGL contexts on real hardware"), so the app
// raises the limit: a page of 20 terminals then keeps all 20 on WebGL, and 40 held with none lost.
// 256, as Superset sets, so a Grid of any size a person opens stays on WebGL.
export const maxWebglContexts = 256

const switchName = "max-active-webgl-contexts"

type CommandLine = {
  hasSwitch(name: string): boolean
  getSwitchValue(name: string): string
  appendSwitch(name: string, value?: string): void
}

/**
 * Raises Chromium's WebGL context limit, which Chromium passes on to its renderer processes,
 * and returns what the limit is. It must run before the app is ready. A limit already on the
 * command line (the profile bench's `--contexts`, or a launcher's) is kept, and told to the
 * page as it stands, so the page's pool never counts more than Chromium allows. Chromium reads
 * the value as plain digits and `appendSwitch` overwrites, so a value that is not plain digits
 * is replaced by the app's limit, and one outside what the contract lets the page be told
 * (`webglContextsRange`) is clamped into it, in the switch itself: the page and Chromium then
 * always hold the same number.
 */
export const raiseWebglContexts = (commandLine: CommandLine): number => {
  const given = commandLine.hasSwitch(switchName) ? commandLine.getSwitchValue(switchName) : ""
  const limit = !commandLine.hasSwitch(switchName)
    ? maxWebglContexts
    : /^\d+$/.test(given)
      ? Math.min(Math.max(Number(given), webglContextsRange.min), webglContextsRange.max)
      : maxWebglContexts
  if (given !== String(limit)) commandLine.appendSwitch(switchName, String(limit))
  return limit
}

/** The window argument that tells the page's preload the limit. */
export const webglContextsArgument = (contexts: number): string =>
  `${webglContextsArgumentPrefix}${contexts}`
