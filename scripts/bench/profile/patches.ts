import { storeSpan } from "./trace.ts"

// The profile's patches to the UI's sources, which build.ts makes in its own builds only, as
// Vite plugins: none of them is the product's.

/**
 * `patch` as a build plugin that must run: it counts the files it patched and fails the build
 * should that not be exactly one, as a patch whose target moved or was renamed would otherwise
 * skip silently and the run would measure the product, not what its flags say.
 */
export const mustRunOnce = <
  Patch extends {
    readonly name: string
    readonly transform: (code: string, id: string) => { code: string; map: null } | null
  },
>(
  patch: Patch,
) => {
  let ran = 0
  return {
    ...patch,
    transform: (code: string, id: string) => {
      const result = patch.transform(code, id)
      if (result) ran += 1
      return result
    },
    buildEnd: (error?: Error) => {
      if (!error && ran !== 1)
        throw new Error(`The ${patch.name} patch patched ${ran} files, not one: its target moved`)
    },
  }
}

// Where the emulator library's view opens a terminal, which the text patch follows with
// `profileText`. The UI's build reads the library as built (dist/view.js, whose open ends in
// a semicolon), its tests as source (src/view.ts). The text goes on the open's own line, so
// no line moves for the maps.
const viewFile = /\/libraries\/emulator\/(?:src\/view\.ts|dist\/view\.js)$/
const opened = /^( *terminal\.open\(element\));?$/gm

/**
 * Every screen's host gets `profileText`, which reads the rows the screen shows from its
 * buffer, only when the profile asks (see ../timing/drive.ts). The WebGL renderer draws its
 * text on a canvas, which has no text content, so a probe reading the page's text needs it;
 * every build gets it, as the pool puts any screen on WebGL.
 */
export const profileTextPatch = {
  name: "profile-text",
  enforce: "pre",
  transform: (code: string, id: string): { code: string; map: null } | null => {
    if (!viewFile.test(id)) return null
    if (code.match(opened)?.length !== 1)
      throw new Error(
        "The emulator's view no longer opens a terminal once, as the profileText patch expects",
      )
    const text =
      'element.profileText = () => { const shown = terminal.buffer.active; let text = ""; for (let row = 0; row < terminal.rows; row += 1) text += (shown.getLine(shown.viewportY + row)?.translateToString(true) ?? "") + "\\n"; return text };'
    return { code: code.replace(opened, `$1; ${text}`), map: null }
  },
} as const

// xterm's WebGL addon, as its bundle exports it (`export{xr as WebglAddon}`, the local name
// minified).
const addonFile = /\/@xterm\/addon-webgl\/lib\/addon-webgl\.mjs$/
const exported = /export\{(\w+) as WebglAddon\}/

/** Where the atlas patch keeps the live addons, on `globalThis`; gpu.ts reads them. */
export const addonRegistry = "__profileWebgl"

/** Where it counts the contexts the addons were told were lost. */
export const lostCounter = "__profileWebglLost"

/**
 * The page's live WebGL addons, in a set on `globalThis` (`addonRegistry`), and a count of
 * the contexts they lost (`lostCounter`): an addon joins once it has activated and
 * leaves when it is disposed. gpu.ts reads each one's atlas through the addon's private
 * fields, which is what a bench-only patch is for: the public `textureAtlas` is the first
 * page's canvas alone. The code goes on the export's own line, so no line moves for the maps.
 */
export const webglAtlasPatch = {
  name: "profile-webgl-atlas",
  enforce: "pre",
  transform: (code: string, id: string): { code: string; map: null } | null => {
    if (!addonFile.test(id)) return null
    const found = exported.exec(code)
    if (!found) throw new Error("The WebGL addon's bundle no longer exports WebglAddon as expected")
    const name = found[1]
    const track = `{ const live = (globalThis.${addonRegistry} = new Set()); globalThis.${lostCounter} = 0; const activate = ${name}.prototype.activate; ${name}.prototype.activate = function (...args) { const result = activate.apply(this, args); live.add(this); this.onContextLoss(() => { globalThis.${lostCounter} += 1 }); return result }; const dispose = ${name}.prototype.dispose; ${name}.prototype.dispose = function (...args) { live.delete(this); return dispose.apply(this, args) } }`
    return { code: code.replace(exported, `${track}; ${found[0]}`), map: null }
  },
} as const

const rendererFile = /\/libraries\/emulator\/(?:src\/renderer\.ts|dist\/renderer\.js)$/
const probe = /^export const probeWebgl = \(\)(?:: boolean)? => \{$/m

/**
 * The pool's hardware check passes whatever draws, so a machine with SwiftShader or
 * llvmpipe gets WebGL screens, which a smoke test of the bench needs: the pool refuses
 * software WebGL, which draws slower than the DOM renderer. The numbers it gives are not the
 * product's.
 */
export const softwareWebglPatch = {
  name: "profile-software-webgl",
  enforce: "pre",
  transform: (code: string, id: string): { code: string; map: null } | null => {
    if (!rendererFile.test(id)) return null
    if (!probe.test(code))
      throw new Error("The emulator's probeWebgl is no longer the function the patch expects")
    return { code: code.replace(probe, "$& return true;"), map: null }
  },
} as const

const viewsFile = /\/frontend\/terminal-views\/src\/renderers\.ts$/
const created = /\bwebglRenderers\(\{$/gm

/**
 * The page's pool takes `cap` contexts, in place of its default: the `contexts` flag raises
 * Chromium's limit to match (`--max-active-webgl-contexts`), and the pool keeps two free, as
 * its default does of 16. The option goes on the call's own line, so no line moves.
 */
export const raisedCapPatch = (contexts: number) =>
  ({
    name: "profile-raised-cap",
    enforce: "pre",
    transform: (code: string, id: string): { code: string; map: null } | null => {
      if (!viewsFile.test(id)) return null
      if (code.match(created)?.length !== 1)
        throw new Error(
          "The page's pool is no longer created by webglRenderers({ as the patch expects",
        )
      return { code: code.replace(created, `$& cap: ${contexts - 2},`), map: null }
    },
  }) as const

// The stores' instrumentation hook, which step 1.3a adds to core/store.ts: it installs a
// function told of each listener a store is about to run, and returns what restores the one
// before.
const hook =
  /\bexport const countListenersWoken = \(\s*\w+: \(\) => void,?\s*\): \(\(\) => void\) =>/

/**
 * A `performance.measure` span around each run of the stores' listeners, through their hook,
 * where core/store.ts has it, and nothing where it doesn't. As the hook tells of a listener
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
    if (!id.endsWith("/frontend/core/src/store.ts")) return null
    if (!/\bexport const countListenersWoken\b/.test(code)) return null
    if (!hook.test(code))
      throw new Error("core/store.ts's countListenersWoken isn't the hook the spans expect")
    const installer = `countListenersWoken((() => { let start; return () => { if (start !== undefined) return; start = performance.now(); queueMicrotask(() => { performance.measure(${JSON.stringify(storeSpan)}, { start }); start = undefined }) } })())`
    return { code: `${code.trimEnd()}\n;${installer}\n`, map: null }
  },
} as const
