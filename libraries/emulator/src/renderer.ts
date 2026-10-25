import { WebglAddon } from "@xterm/addon-webgl"
import type { IEvent, Terminal } from "@xterm/xterm"

// xterm draws with its DOM renderer unless the WebGL addon takes over, which costs a
// fraction of the main thread's time on a busy page of terminals. This module is all the WebGL
// handling: which screens hold a context, and when one goes back to the DOM renderer.

// Chromium keeps 16 live WebGL contexts per renderer process on desktop, and loses the
// oldest when more are asked for (it warns on the console and fires webglcontextlost), which
// would blank a terminal that is still shown. The default pool takes all but two, kept for a
// canvas the page doesn't own and as a margin while a context the GPU lost waits to be freed.
// That is a page of 13 or 14 terminals all on WebGL, where one busy terminal left on the DOM
// costs about as much as the other twelve; a shown screen past the cap draws with the DOM
// renderer until a slot frees.
export const contextCap = 14
// How many times a screen may lose its context, or fail to load one; it tries again when
// it is shown again, once, and stays on the DOM renderer after that.
const lossesAllowed = 2

// What a loaded addon gives back; xterm's WebglAddon is one.
export type Drawing = {
  readonly onContextLoss: IEvent<void>
  readonly clearTextureAtlas: () => void
  // What tells which drawings share a glyph atlas: the same value, or undefined while it
  // has none. xterm's addon gives the atlas's first page canvas.
  readonly atlas: () => unknown
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

// What the pool has counted since the page opened, for the bench and the app's logs.
export type PoolStats = {
  // Shown screens that found the pool full and had to wait for a context.
  readonly waits: number
  // Contexts taken from idle screens for waiting ones.
  readonly steals: number
  // Renderer changes, either way: a screen taking a context or giving it back.
  readonly swaps: number
  // Contexts the GPU lost.
  readonly lost: number
  // Loads that failed, as on a context refused for a moment.
  readonly failed: number
  // Pty resizes a renderer change caused, as its cells measured another size.
  readonly resizes: number
  // A current value, not a total: shown screens wanting WebGL that have no context for lack of
  // one, not counting those that ran out of tries after losses.
  readonly onDom: number
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
  // The font may have changed under glyphs already drawn. Once the current task's
  // synchronous work is over, the screen's glyph atlas is cleared and every screen sharing
  // that atlas redraws from it, as xterm clears it for the one that asked alone.
  readonly refresh: () => void
  // A renderer change fit the screen to another size, which went to its pty.
  readonly resized: () => void
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
  // Counted as waiting for a context, until it has one or is no longer shown.
  waiting: boolean
  closed: boolean
}

export const createRenderers = <Target>(deps: RendererDeps<Target>) => {
  const members = new Set<Member<Target>>()
  let held = 0
  let clock = 0
  let supported: boolean | undefined
  let unwatch: (() => void) | undefined
  let stealing = false
  const defer = deps.defer ?? queueMicrotask
  const counts = { waits: 0, steals: 0, swaps: 0, lost: 0, failed: 0, resizes: 0 }
  const watchers = new Set<() => void>()
  const count = (what: keyof typeof counts): void => {
    counts[what] += 1
    notify()
  }
  // A watcher that throws must not break the pool's work that told it.
  const notify = (): void => {
    for (const watcher of watchers) {
      try {
        watcher()
      } catch {
        // Its own trouble.
      }
    }
  }
  // Whether a shown screen wanting WebGL lacks a context, as nothing here is holding it back
  // (an idle one is let go first) but the pool's cap or a context that did not load.
  const bare = (member: Member<Target>): boolean =>
    member.shown && !member.idle && member.webgl && !member.drawing && member.losses < lossesAllowed
  let lastOnDom = 0
  const domCount = (): number => (usable() ? [...members].filter(bare).length : 0)
  // Tells the watchers when the screens on the DOM for lack of a context changed in number.
  const settled = (): void => {
    const now = domCount()
    if (now === lastOnDom) return
    lastOnDom = now
    notify()
  }
  // Drawings whose screens asked for a clear, and whether the microtask that does it is queued.
  const asked = new Set<Member<Target>>()
  // The atlases of drawings that asked and were let go before the moment was over.
  const gone = new Set<unknown>()
  let sharing = false

  // xterm clears a glyph atlas for the screen that asked and tells no other screen drawing
  // from it, which keep glyph coordinates into pages that are blank or hold others by then
  // (xterm.js #6014). So the clear is done once for every drawing on the atlas, at the same
  // moment: the atlas is empty when the first clears it, and the rest rebuild their models
  // against it before anything draws.
  const clearAtlases = (): void => {
    sharing = false
    const wanted = new Set(asked)
    asked.clear()
    const drawn = [...members].filter((member) => member.drawing)
    // Read together, as the identity can change when xterm merges pages.
    const atlases = new Map(drawn.map((member) => [member, member.drawing?.atlas()]))
    const cleared = new Set(gone)
    gone.clear()
    for (const member of wanted) {
      const atlas = atlases.get(member)
      if (atlas !== undefined) cleared.add(atlas)
    }
    for (const member of drawn) {
      const atlas = atlases.get(member)
      if (wanted.has(member) || (atlas !== undefined && cleared.has(atlas)))
        member.drawing?.clearTextureAtlas()
    }
  }

  // Ligatures keep every screen on the DOM renderer: WebGL draws per cell and cannot join glyphs.
  const usable = (): boolean => {
    supported ??= deps.supported()
    return supported && !deps.ligatures()
  }

  const drop = (member: Member<Target>): void => {
    const { drawing } = member
    if (!drawing) return
    member.drawing = undefined
    held -= 1
    // Asked to clear its atlas, and let go before the moment is over: the others sharing it
    // still clear.
    if (asked.delete(member)) {
      const atlas = drawing.atlas()
      if (atlas !== undefined) gone.add(atlas)
    }
    // Disposing the addon returns xterm to the DOM renderer.
    drawing.dispose()
    swapped(member)
  }

  const swapped = (member: Member<Target>): void => {
    if (!member.closed) count("swaps")
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
    count("steals")
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
    fillSlots(fromIdle)
    settled()
  }
  const fillSlots = (fromIdle: boolean): void => {
    while (usable()) {
      let next: Member<Target> | undefined
      const waiting: Member<Target>[] = []
      for (const member of members) {
        if (!member.shown || member.idle || !member.webgl || member.drawing || member.lost) continue
        if (member.losses >= lossesAllowed) continue
        waiting.push(member)
        if (!next || member.since < next.since) next = member
      }
      if (!next) return
      const member = next
      if (held >= deps.cap) {
        // Every shown screen without a context waits, not only the one first in line.
        for (const other of waiting) {
          if (other.waiting) continue
          other.waiting = true
          count("waits")
        }
        if (!fromIdle) return later()
        if (!steal()) return
      }
      let drawing: Drawing
      try {
        drawing = deps.load(member.target)
      } catch {
        // As a lost context: a GPU process restarting can refuse one for a moment.
        member.losses += 1
        member.lost = true
        count("failed")
        continue
      }
      member.drawing = drawing
      member.waiting = false
      held += 1
      drawing.onContextLoss(() => {
        if (member.drawing !== drawing) return
        member.losses += 1
        member.lost = true
        count("lost")
        drop(member)
        fill()
      })
      swapped(member)
    }
  }

  const changed = (): void => {
    if (usable()) return fill()
    // Off, and on again, is a new episode for whoever has to wait then.
    for (const member of members) member.waiting = false
    for (const member of members) drop(member)
    settled()
  }

  return {
    stats: (): PoolStats => ({
      ...counts,
      onDom: domCount(),
    }),
    // Tells `listener` after each count changes, until the returned function is called.
    watch: (listener: () => void): (() => void) => {
      watchers.add(listener)
      return () => void watchers.delete(listener)
    },
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
        waiting: false,
        closed: false,
      }
      members.add(member)
      unwatch ??= deps.watchLigatures(changed)
      const leave = (): void => {
        member.shown = false
        member.idle = false
        member.waiting = false
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
          if (!webgl) {
            member.waiting = false
            drop(member)
          }
          fill()
        },
        idle: () => {
          if (!member.shown || member.idle) return
          member.idle = true
          member.idleSince = clock++
          later()
        },
        release: leave,
        refresh: () => {
          if (!member.drawing) return
          asked.add(member)
          if (sharing) return
          sharing = true
          defer(clearAtlases)
        },
        resized: () => count("resizes"),
        dispose: () => {
          // A screen that closes has nothing to fit again.
          member.switched = () => {}
          member.closed = true
          leave()
          members.delete(member)
          settled()
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
    atlas: () => addon.textureAtlas,
    // The addon's dispose leaves its context to the garbage collector, and until then
    // Chromium counts it against the page's contexts and drops live ones for it; the
    // context is lost on the way out instead.
    dispose: () => {
      addon.dispose()
      gl?.getExtension("WEBGL_lose_context")?.loseContext()
    },
  }
}

// The pool for a page of xterm terminals, loading xterm's WebGL addon where the page has a
// hardware context to spare. Ligatures render through CSS `font-variant-ligatures`, which only
// the DOM renderer gets, so the page says whether they are on and when that changes.
export const webglRenderers = (options: {
  readonly ligatures: () => boolean
  readonly watchLigatures: (changed: () => void) => () => void
  readonly cap?: number
}): Renderers =>
  createRenderers<Terminal>({
    load: loadWebgl,
    supported: probeWebgl,
    cap: options.cap ?? contextCap,
    ligatures: options.ligatures,
    watchLigatures: options.watchLigatures,
  })
