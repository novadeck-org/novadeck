import { WebglAddon } from "@xterm/addon-webgl"
import type { IEvent, Terminal } from "@xterm/xterm"

import type { ViewMode } from "../../model/types"

// xterm draws with its DOM renderer unless the WebGL addon takes over, which costs a
// fraction of the main thread's time on a busy Grid. This module is all the WebGL
// handling: which screens hold a context, and when one goes back to the DOM renderer.

// Chromium keeps 16 live WebGL contexts per renderer process on desktop, which is this
// page's, and loses the oldest when more are asked for (it warns on the console and fires
// webglcontextlost), which would blank a terminal that is still shown. The app draws
// nothing else with WebGL, so the screens take all but two, kept for a canvas the page
// doesn't own (an extension's, in the browser build) and as a margin while a context the
// GPU lost waits to be freed.
// That is a Grid of 13 or 14 all on WebGL, where one busy terminal left on the DOM costs
// about as much as the other twelve; a shown screen past the cap draws with the DOM
// renderer until a slot frees.
export const contextCap = 14
// Whether a view's screens draw with WebGL. Canvas zooms its windows with a CSS transform,
// which the DOM renderer's text is drawn again at but WebGL's canvas is stretched by, soft
// above one and ragged below, so Canvas keeps the DOM renderer.
export const wantsWebgl = (view: ViewMode): boolean => view !== "canvas"
// How many times a screen may lose its context, or fail to load one; it tries again when
// it is shown again, once, and stays on the DOM renderer after that.
const lossesAllowed = 2

// What a loaded addon gives back; xterm's WebglAddon is one.
export type Drawing = {
  readonly onContextLoss: IEvent<void>
  readonly clearTextureAtlas: () => void
  readonly dispose: () => void
}

export type RendererDeps<Target> = {
  // Loads the addon into a target, or throws, leaving the target on the DOM renderer.
  readonly load: (target: Target) => Drawing
  // Whether a real GPU context can be had; asked once.
  readonly supported: () => boolean
  readonly cap: number
  // Whether ligatures are on, and a way to hear when that changes.
  readonly ligatures: () => boolean
  readonly watchLigatures: (changed: () => void) => () => void
  // Runs work once the current task's synchronous work is over; a microtask by default.
  readonly defer?: (work: () => void) => void
}

// One screen's side of the pool.
export type ScreenRenderer = {
  // The screen is shown: it takes a context when one is free, or waits for one. Shown
  // where WebGL isn't wanted, it stays on the DOM renderer and gives back one it holds.
  readonly take: (webgl?: boolean) => void
  // Nothing shows the screen now, though it may be shown again at once, as in a view
  // switch: once that moment is over, a shown screen waiting for a context takes its own.
  // `take` ends it.
  readonly idle: () => void
  // The screen is parked and draws nothing: it gives its context back.
  readonly release: () => void
  // The font may have changed under glyphs already drawn.
  readonly refresh: () => void
  readonly dispose: () => void
}

type Member<Target> = {
  readonly target: Target
  // Told when the screen changes renderer, either way.
  switched: () => void
  shown: boolean
  // Shown by no surface for the moment; its context, alone, may go to a waiter.
  idle: boolean
  // When it went idle; the longest idle goes first.
  idleSince: number
  // Whether where it's shown wants WebGL.
  webgl: boolean
  drawing?: Drawing | undefined
  // When the screen began waiting, among the shown ones; the longest waiting goes first.
  since: number
  losses: number
  // Lost its context, or failed to load one, and waits for the next take.
  lost: boolean
}

export const createRenderers = <Target>(deps: RendererDeps<Target>) => {
  const members = new Set<Member<Target>>()
  let held = 0
  let clock = 0
  let supported: boolean | undefined
  let unwatch: (() => void) | undefined
  let stealing = false
  const defer = deps.defer ?? queueMicrotask

  // Ligatures keep every screen on the DOM renderer (see `browserDeps.ligatures`).
  const usable = (): boolean => {
    supported ??= deps.supported()
    return supported && !deps.ligatures()
  }

  const drop = (member: Member<Target>): void => {
    const { drawing } = member
    if (!drawing) return
    member.drawing = undefined
    held -= 1
    // Disposing the addon returns xterm to the DOM renderer.
    drawing.dispose()
    member.switched()
  }

  // Takes the context of the screen that has been idle longest, for a waiting one.
  const steal = (): boolean => {
    let victim: Member<Target> | undefined
    for (const member of members) {
      if (!member.idle || !member.drawing) continue
      if (!victim || member.idleSince < victim.idleSince) victim = member
    }
    if (!victim) return false
    drop(victim)
    return true
  }

  // Takes idle screens' contexts for waiting ones, once the moment is over. A view switch
  // releases every surface and acquires them again in one go: stealing in its middle
  // would take the context of a screen about to be shown again, which would take the next
  // one's, down the line.
  const later = (): void => {
    if (stealing) return
    stealing = true
    defer(() => {
      stealing = false
      fill(true)
    })
  }

  // Gives free slots to the shown screens on the DOM renderer, longest waiting first. A
  // screen nobody shows at the moment keeps its context until one of them has none to
  // take, and then only once the moment is over (`later`).
  const fill = (fromIdle = false): void => {
    while (usable()) {
      let next: Member<Target> | undefined
      for (const member of members) {
        if (!member.shown || member.idle || !member.webgl || member.drawing || member.lost) continue
        if (member.losses >= lossesAllowed) continue
        if (!next || member.since < next.since) next = member
      }
      if (!next) return
      if (held >= deps.cap) {
        if (!fromIdle) return later()
        if (!steal()) return
      }
      const member = next
      let drawing: Drawing
      try {
        drawing = deps.load(member.target)
      } catch {
        // As a lost context: a GPU process restarting can refuse one for a moment.
        member.losses += 1
        member.lost = true
        continue
      }
      member.drawing = drawing
      held += 1
      drawing.onContextLoss(() => {
        if (member.drawing !== drawing) return
        member.losses += 1
        member.lost = true
        drop(member)
        fill()
      })
      member.switched()
    }
  }

  const changed = (): void => {
    if (usable()) return fill()
    for (const member of members) drop(member)
  }

  return {
    screen: (target: Target, switched: () => void = () => {}): ScreenRenderer => {
      const member: Member<Target> = {
        target,
        switched,
        shown: false,
        idle: false,
        idleSince: 0,
        webgl: true,
        since: 0,
        losses: 0,
        lost: false,
      }
      members.add(member)
      unwatch ??= deps.watchLigatures(changed)
      const leave = (): void => {
        member.shown = false
        member.idle = false
        drop(member)
        fill()
      }
      return {
        take: (webgl = true) => {
          // Shown afresh, after a park: a screen that lost its context tries again then.
          if (!member.shown) {
            member.since = clock++
            member.lost = false
          }
          member.shown = true
          member.idle = false
          member.webgl = webgl
          if (!webgl) drop(member)
          fill()
        },
        idle: () => {
          if (!member.shown || member.idle) return
          member.idle = true
          member.idleSince = clock++
          later()
        },
        release: leave,
        refresh: () => member.drawing?.clearTextureAtlas(),
        dispose: () => {
          // A screen that closes has nothing to fit again.
          member.switched = () => {}
          leave()
          members.delete(member)
          if (members.size > 0) return
          unwatch?.()
          unwatch = undefined
        },
      }
    },
  }
}

export type Renderers = ReturnType<typeof createRenderers<Terminal>>

let probed: boolean | undefined
const software = /swiftshader|llvmpipe|softpipe|software|basic render/i
// Whether the page can have a hardware WebGL 2 context, found once. Software WebGL draws
// slower than the DOM renderer, and two checks tell it apart: `failIfMajorPerformanceCaveat`
// makes Chromium refuse a context that would run on software, but it does not always flag
// SwiftShader as a major caveat (headless Chromium gets a context anyway), so the
// context's renderer name is read as well; Microsoft's Basic Render Driver is the Windows
// one. The probe's context is freed at once so it doesn't take one of the page's slots.
export const probeWebgl = (): boolean => {
  if (probed !== undefined) return probed
  probed = false
  if (typeof WebGL2RenderingContext === "undefined") return probed
  let context: WebGL2RenderingContext | null | undefined
  try {
    context = document
      .createElement("canvas")
      .getContext("webgl2", { failIfMajorPerformanceCaveat: true })
    if (!context) return probed
    const info = context.getExtension("WEBGL_debug_renderer_info")
    const renderer: unknown = context.getParameter(
      info ? info.UNMASKED_RENDERER_WEBGL : context.RENDERER,
    )
    probed = !software.test(String(renderer))
  } catch {
    // No context, as without a GPU.
  } finally {
    try {
      context?.getExtension("WEBGL_lose_context")?.loseContext()
    } catch {
      // A context that can't be asked has nothing more to give back.
    }
  }
  return probed
}

// The ligatures setting is one attribute on the page's root, set from Preferences.
const watchRoot = (changed: () => void): (() => void) => {
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-ligatures"],
  })
  return () => observer.disconnect()
}

// The WebGL context among a screen's canvases. Asking a 2D canvas for WebGL gives nothing
// and creates nothing.
const contextOf = (found: readonly HTMLCanvasElement[]): WebGL2RenderingContext | undefined =>
  found.map((canvas) => canvas.getContext("webgl2")).find((context) => context !== null) ??
  undefined

// Loads xterm's WebGL addon into a screen, as a drawing whose dispose frees its context.
// The terminal is open already, so its canvases are there to find.
export const loadWebgl = (xterm: Terminal): Drawing => {
  const canvases = (): HTMLCanvasElement[] => [...(xterm.element?.querySelectorAll("canvas") ?? [])]
  const before = new Set(canvases())
  // What this load added: its own canvases, the one holding WebGL among them.
  const added = (): HTMLCanvasElement[] => canvases().filter((canvas) => !before.has(canvas))
  const addon = new WebglAddon()
  try {
    xterm.loadAddon(addon)
  } catch (error) {
    // A renderer that failed partway, as on a context lost mid-load, leaves its canvases
    // and its context behind; they go with it. Its listeners stay subscribed to the
    // terminal until it closes, as the addon never got hold of the renderer to dispose.
    const left = added()
    contextOf(left)?.getExtension("WEBGL_lose_context")?.loseContext()
    for (const canvas of left) canvas.remove()
    addon.dispose()
    throw error
  }
  const gl = contextOf(added())
  return {
    onContextLoss: addon.onContextLoss,
    clearTextureAtlas: () => addon.clearTextureAtlas(),
    // The addon's dispose leaves its context to the garbage collector, and until then
    // Chromium counts it against the page's contexts and drops live ones for it; the
    // context is lost on the way out instead.
    dispose: () => {
      addon.dispose()
      gl?.getExtension("WEBGL_lose_context")?.loseContext()
    },
  }
}

const browserDeps: RendererDeps<Terminal> = {
  load: loadWebgl,
  supported: probeWebgl,
  cap: contextCap,
  // The trade-off: ligatures render through CSS `font-variant-ligatures`, which only the
  // DOM renderer gets; WebGL draws per cell and cannot join glyphs. So every screen stays on
  // the DOM renderer while they are on (no ligatures addon for now).
  ligatures: () => document.documentElement.dataset.ligatures === "on",
  watchLigatures: watchRoot,
}

let page: Renderers | undefined
// The page's pool: the context budget is the page's, whichever backend's screens draw.
export const pageRenderers = (): Renderers => (page ??= createRenderers(browserDeps))
