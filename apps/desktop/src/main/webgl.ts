import { webglContextsOf } from "@novadeck/protocol/bridge"

import { webglContextsArgumentPrefix } from "../bridge.js"

// Chromium keeps 16 live WebGL contexts per renderer process and loses the oldest when more
// are asked for, which capped the page's pool at 14 terminals on WebGL (see
// @novadeck/emulator's `contextCap`). A context costs about 1 MB in the GPU process and 1.6 MB
// in the renderer (architecture/performance.md, "WebGL contexts on real hardware"), so the app
// raises the limit: a page of 20 terminals then keeps all 20 on WebGL, and 40 held with none lost.
export const maxWebglContexts = 64

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
 * page as it stands, so the page's pool never counts more than Chromium allows; one that is no
 * valid limit is replaced.
 */
export const raiseWebglContexts = (commandLine: CommandLine): number => {
  const given = commandLine.hasSwitch(switchName)
    ? webglContextsOf(Number(commandLine.getSwitchValue(switchName)))
    : undefined
  if (given !== undefined) return given
  // appendSwitch leaves a switch already present as it is, so a bad one stays; the page is
  // told the default Chromium then has.
  if (commandLine.hasSwitch(switchName)) return 16
  commandLine.appendSwitch(switchName, String(maxWebglContexts))
  return maxWebglContexts
}

/** The window argument that tells the page's preload the limit. */
export const webglContextsArgument = (contexts: number): string =>
  `${webglContextsArgumentPrefix}${contexts}`
