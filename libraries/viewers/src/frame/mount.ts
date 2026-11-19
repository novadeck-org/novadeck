import { openFrame, type FrameCode, type OpenFrame } from "./host.js"
import type { CommonMessage, PaneAction } from "./messages.js"

// A viewer whose code runs in a frame of its own (frame.html), never in the app's page: the
// frame is sandboxed with scripts only, so it has an opaque origin, and its page allows no
// network, no storage and no script but what this hands it. What it's shown goes in as
// messages; out come only the messages the viewer's own check lets through, so a script that
// file somehow ran in the frame reaches neither the app's page, its storage, nor its
// connection to the runner. This is what every such viewer shares: the frame and its start,
// the glass that keeps the focus the person's to give, the pane's actions for the frame's keys,
// the app's look, and letting go of a frame that went elsewhere or never started.

export type FrameMount = {
  readonly host: HTMLElement
  /** Sends the frame a message, kept till it's ready (see `many`). */
  readonly post: (message: Record<string, unknown>, transfer?: Transferable[]) => void
  /** Gives the frame the focus, as the app focusing the viewer does. */
  readonly focus: () => void
  readonly destroy: () => void
}

export type FrameOptions<Message extends { readonly type: string }> = {
  /** The classes' prefix: `<name>-host`, `-frame`, `-glass` and `-host-notice` (see pdf.css). */
  readonly name: string
  readonly label: string
  /** The frame's page as the app serves it, and the viewer's code. */
  readonly url: string
  readonly code: FrameCode
  /** One more script, setting `self.frameViewer`, as a test of the frame's walls gives. */
  readonly viewer?: string | undefined
  /** The tokens the frame draws with, read from where the viewer mounts. */
  readonly tokens: readonly string[]
  /** What the notice says once the frame is let go of. */
  readonly stoppedText: string
  /** The viewer's check of what its frame says; anything it doesn't return is dropped. */
  readonly check: (data: unknown) => Message | CommonMessage | undefined
  /** A checked message of the viewer's own. */
  readonly hear: (message: Message) => void
  /** Kinds of message of which all wait for the frame, not only the latest. */
  readonly many?: readonly string[]
  /** The frame started, after its label and look went to it. */
  readonly onReady?: () => void
  /** The frame was let go of, after the notice says so. */
  readonly onStopped?: () => void
  readonly onAction?: ((action: PaneAction) => void) | undefined
  /** A drag that starts on the glass goes to the frame, as one over it would. */
  readonly drag?: boolean
  /** The frame hears when it's out of view, and back. */
  readonly visibility?: boolean
}

// The pane's actions a frame may ask for: a burst past this is a frame misbehaving. How long a
// frame has to start, and what may wait for it meanwhile.
const actionsPerSecond = 5
const startMs = 30_000
const queued = 16

export const mountFrame = <Message extends { readonly type: string }>(
  element: HTMLElement,
  options: FrameOptions<Message>,
): FrameMount => {
  const { name, label, tokens } = options
  const document = element.ownerDocument
  const win = document.defaultView ?? window
  const host = document.createElement("div")
  host.className = `${name}-host`
  host.setAttribute("aria-busy", "true")
  const iframe = document.createElement("iframe")
  // Scripts only: no same origin, so the frame's is opaque, and no popups, forms, top
  // navigation or downloads.
  iframe.setAttribute("sandbox", "allow-scripts")
  iframe.referrerPolicy = "no-referrer"
  iframe.title = label
  iframe.className = `${name}-frame`
  // Reached through the glass, never by Tab straight into the frame.
  iframe.tabIndex = -1
  // Over the frame while it hasn't the focus, so only the person gives it the focus: a press on
  // it, or Tab to it, lets the frame have it. A scroll or pinch over it goes to the frame.
  const glass = document.createElement("div")
  glass.className = `${name}-glass`
  glass.tabIndex = 0
  glass.setAttribute("role", "button")
  glass.setAttribute("aria-label", label)
  const notice = document.createElement("p")
  notice.className = `${name}-host-notice`
  notice.setAttribute("role", "alert")
  notice.hidden = true
  host.append(iframe, glass, notice)
  element.append(host)

  let opened: OpenFrame | undefined
  let ready = false
  let destroyed = false
  // Let go of: nothing more goes to it.
  let stopped = false
  // What waits for the frame to be ready: of each kind but `many`, only the latest, so a file
  // rewritten again and again holds one copy of its bytes.
  const many = options.many ?? []
  let queue: { message: Record<string, unknown>; transfer: Transferable[] }[] = []
  const post = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    if (destroyed || stopped) return
    if (ready && opened) return opened.post(message, transfer)
    if (!many.includes(message.type as string))
      queue = queue.filter((each) => each.message.type !== message.type)
    if (queue.length < queued) queue.push({ message, transfer })
  }

  const theme = (): void => {
    const style = win.getComputedStyle(host)
    const values: Record<string, string> = {}
    for (const token of tokens) {
      const value = style.getPropertyValue(token).trim()
      if (value) values[token] = value
    }
    const scheme = win.getComputedStyle(document.documentElement).colorScheme
    const dark = /\bdark\b/.test(scheme) && !/\blight\b/.test(scheme)
    const light = /\blight\b/.test(scheme) && !/\bdark\b/.test(scheme)
    const preferred = win.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    post({ type: "theme", tokens: values, scheme: dark ? "dark" : light ? "light" : preferred })
  }

  let actions: number[] = []
  const act = (action: PaneAction): void => {
    // Only for a key the person pressed in this frame: it has the focus they gave it.
    if (!given || document.activeElement !== iframe || !options.onAction) return
    const now = win.performance.now()
    actions = actions.filter((at) => now - at < 1000)
    if (actions.length >= actionsPerSecond) return
    actions.push(now)
    options.onAction(action)
  }

  const hear = (message: Message | CommonMessage): void => {
    switch (message.type) {
      case "ready":
        if (ready) return
        ready = true
        win.clearTimeout(starting)
        opened?.post({ type: "label", label })
        theme()
        if (options.visibility) opened?.post({ type: "visible", visible })
        for (const { message: waiting, transfer } of queue.splice(0))
          opened?.post(waiting, transfer)
        return options.onReady?.()
      case "busy":
        return host.setAttribute(
          "aria-busy",
          String((message as CommonMessage & { busy: boolean }).busy),
        )
      case "action":
        return act((message as CommonMessage & { action: PaneAction }).action)
      default:
        return options.hear(message as Message)
    }
  }

  // The frame went somewhere else than its page, which only a script in it could do, or never
  // started: it's let go of, and says so.
  const stop = (): void => {
    stopped = true
    ready = false
    queue = []
    opened?.close()
    win.clearTimeout(starting)
    iframe.remove()
    notice.textContent = options.stoppedText
    notice.hidden = false
    host.setAttribute("aria-busy", "false")
    options.onStopped?.()
  }

  opened = openFrame({
    iframe,
    url: options.url,
    code: options.code,
    viewer: options.viewer,
    hear: (data) => {
      const message = options.check(data)
      if (message) hear(message)
    },
    stopped: stop,
  })
  // A frame that never starts, as when its code couldn't be read, is let go of too.
  const starting = win.setTimeout(() => {
    if (!ready && !destroyed) stop()
  }, startMs)

  // The frame takes the focus only when the person gives it: through the glass, or when the app
  // focuses the viewer. Taken any other way, by a script in the frame, it goes back to where it
  // was, so nothing typed for elsewhere reaches the frame.
  let given = false
  let before: Element | null = null
  // A drag begun on the glass, which keeps it till the drag ends.
  let dragging: number | undefined
  const give = (): void => {
    given = true
    iframe.focus({ preventScroll: true })
    // A frame that couldn't take it, as one hidden, wasn't given it.
    given = document.activeElement === iframe
    if (given) post({ type: "focus" })
  }
  const remember = (event: FocusEvent): void => {
    if (event.target !== iframe) before = event.target as Element
  }
  // The frame has the focus it wasn't given: back where it was. A frame the person used may take
  // it with no event on the iframe here, so each focus that leaves something here is checked too.
  const putBack = (): void => {
    if (given || stopped || document.activeElement !== iframe) return
    const back = before as HTMLElement | null
    if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true })
    else iframe.blur()
  }
  let checking = 0
  const check = (): void => {
    win.clearTimeout(checking)
    checking = win.setTimeout(putBack, 0)
  }
  document.addEventListener("focusin", remember, true)
  document.addEventListener("focusout", check, true)
  // With nothing here holding the focus, no focusout comes: the window's blur does, as the focus
  // goes into a frame, and a press anywhere checks too.
  win.addEventListener("blur", check)
  document.addEventListener("pointerdown", check, true)
  iframe.addEventListener("focus", () => {
    if (given) return void (glass.hidden = dragging === undefined)
    putBack()
  })
  iframe.addEventListener("blur", () => {
    given = false
    glass.hidden = false
  })
  // Where a pointer is over the frame, and which buttons and keys it has, as the frame takes it.
  const pointer = (event: PointerEvent, phase: "start" | "move" | "end") => {
    const box = iframe.getBoundingClientRect()
    return {
      type: "drag",
      phase,
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      buttons: event.buttons,
      shift: event.shiftKey,
      ctrl: event.ctrlKey || event.metaKey,
    }
  }
  glass.addEventListener("pointerdown", (event) => {
    event.preventDefault()
    // The glass stays over the frame while the drag lasts, so it keeps the pointer.
    if (options.drag) dragging = event.pointerId
    give()
    if (dragging === undefined) return
    if (!given) return void (dragging = undefined)
    glass.setPointerCapture(event.pointerId)
    post(pointer(event, "start"))
  })
  glass.addEventListener("pointermove", (event) => {
    if (event.pointerId === dragging) post(pointer(event, "move"))
  })
  const dropped = (event: PointerEvent): void => {
    if (event.pointerId !== dragging) return
    dragging = undefined
    post(pointer(event, "end"))
    if (given) glass.hidden = true
  }
  // A right-button drag moves a model: the app's menu stays shut over it.
  glass.addEventListener("contextmenu", (event) => {
    if (options.drag) event.preventDefault()
  })
  glass.addEventListener("pointerup", dropped)
  glass.addEventListener("pointercancel", dropped)
  glass.addEventListener("focus", give)
  // A scroll or pinch over the glass goes to the frame, as one over the frame would.
  glass.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault()
      const box = iframe.getBoundingClientRect()
      post({
        type: "wheel",
        x: event.deltaX,
        y: event.deltaY,
        mode: event.deltaMode,
        zoom: event.ctrlKey || event.metaKey,
        at: { x: event.clientX - box.left, y: event.clientY - box.top },
      })
    },
    { passive: false },
  )

  // Out of view, as scrolled off a canvas: the frame may let go of what drawing holds.
  let visible = true
  const seen = options.visibility
    ? new win.IntersectionObserver((entries) => {
        const now = entries.at(-1)?.isIntersecting ?? visible
        if (now === visible) return
        visible = now
        post({ type: "visible", visible })
      })
    : undefined
  seen?.observe(host)

  // The app's light or dark, and its tokens, as they change.
  const scheme = win.matchMedia("(prefers-color-scheme: dark)")
  scheme.addEventListener("change", theme)
  const looks = new win.MutationObserver(theme)
  looks.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-scheme"],
  })

  return {
    host,
    post,
    focus: give,
    destroy: () => {
      destroyed = true
      win.clearTimeout(starting)
      document.removeEventListener("focusin", remember, true)
      document.removeEventListener("focusout", check, true)
      win.removeEventListener("blur", check)
      document.removeEventListener("pointerdown", check, true)
      win.clearTimeout(checking)
      opened?.close()
      scheme.removeEventListener("change", theme)
      looks.disconnect()
      seen?.disconnect()
      host.remove()
    },
  }
}
