import { storeSpan } from "./trace.ts"

// The profile's patches to the UI's sources, which build.ts makes in its own builds only, as
// Vite plugins: none of them is the product's.

// Where screens.ts opens a screen, which the WebGL patch follows with the addon. The import
// goes on the file's first line and the addon on the open's own, so no line moves for the
// maps. A context the GPU process takes back marks the screen's host, which the profile
// checks (drive.ts): a screen that lost it draws nothing. As the WebGL renderer draws its text
// on a canvas, the host also gets `profileText`, which reads the rows it shows from the
// buffer, only when the profile asks (see ../timing/drive.ts).
const opened = "    xterm.open(element)\n"

const loaded = [
  "const webgl = new WebglAddon();",
  'webgl.onContextLoss(() => element.setAttribute("data-profile-webgl-lost", ""));',
  "xterm.loadAddon(webgl);",
  'element.profileText = () => { const shown = xterm.buffer.active; let text = ""; for (let row = 0; row < xterm.rows; row += 1) text += (shown.getLine(shown.viewportY + row)?.translateToString(true) ?? "") + "\\n"; return text };',
].join(" ")

/** Every screen draws with xterm's WebGL renderer, in place of its DOM one. */
export const webglPatch = {
  name: "profile-webgl",
  enforce: "pre",
  transform: (code: string, id: string): { code: string; map: null } | null => {
    if (!id.endsWith("/src/backend/runner/screens.ts")) return null
    if (code.split(opened).length !== 2)
      throw new Error("screens.ts no longer opens a screen once, as the WebGL patch expects")
    return {
      code: `import { WebglAddon } from "@novadeck/emulator/browser"; ${code.replace(
        opened,
        `${opened.trimEnd()}; ${loaded}\n`,
      )}`,
      map: null,
    }
  },
} as const

// The stores' instrumentation hook, which step 1.3a adds to model/store.ts: it installs a
// function told of each listener a store is about to run, and returns what restores the one
// before.
const hook =
  /\bexport const countListenersWoken = \(\s*\w+: \(\) => void,?\s*\): \(\(\) => void\) =>/

/**
 * A `performance.measure` span around each run of the stores' listeners, through their hook,
 * where model/store.ts has it, and nothing where it doesn't. As the hook tells of a listener
 * about to run, never of one done, a span runs from the first listener woken to a microtask
 * queued then, which runs at the next microtask checkpoint: once the script running them,
 * an event's listener or a promise's continuation, is done, the listeners, their selectors
 * and anything that script ran after them included. A render React had already scheduled
 * as a microtask before the first listener runs falls inside the span; the one the listeners
 * ask for comes later, outside it. The installer goes on a line of its own after the module's
 * last, so no line moves for the maps.
 */
export const storeSpansPatch = {
  name: "profile-store-spans",
  enforce: "pre",
  transform: (code: string, id: string): { code: string; map: null } | null => {
    if (!id.endsWith("/src/model/store.ts")) return null
    if (!/\bexport const countListenersWoken\b/.test(code)) return null
    if (!hook.test(code))
      throw new Error("model/store.ts's countListenersWoken isn't the hook the spans expect")
    const installer = `countListenersWoken((() => { let start; return () => { if (start !== undefined) return; start = performance.now(); queueMicrotask(() => { performance.measure(${JSON.stringify(storeSpan)}, { start }); start = undefined }) } })())`
    return { code: `${code.trimEnd()}\n;${installer}\n`, map: null }
  },
} as const
