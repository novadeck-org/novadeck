// Starts a viewer's frame (frame.html) in `iframe`, which its caller makes and sandboxes: once
// its page has loaded, hands it the viewer's scripts as text, to run in order, a worker's if it
// has one, and one end of a channel; everything the frame says after comes over the channel's
// other end, to `hear`, unchecked (the caller checks it). The scripts end by setting
// `self.frameViewer`, which the page calls with that end; `viewer`, if given, is one more script
// that sets it. The page's own script takes only this one message, and only from its parent.
// Should the frame load another page after its own, which only a script in it could make it do,
// `stopped` is called and it hears nothing more.

/** A viewer's code as its frame runs it: classic scripts, and a worker's, as text. */
export type FrameScripts = { readonly scripts: readonly string[]; readonly worker?: string }
export type FrameCode = () => Promise<FrameScripts>

// Each viewer's code, read once for every frame of it.
const known = new WeakMap<FrameCode, Promise<FrameScripts>>()
const codeOf = (code: FrameCode): Promise<FrameScripts> => {
  const read = known.get(code) ?? code()
  known.set(code, read)
  return read
}

export type OpenFrame = {
  readonly post: (message: Record<string, unknown>, transfer?: Transferable[]) => void
  readonly close: () => void
}

export const openFrame = ({
  iframe,
  url,
  code,
  viewer,
  hear,
  stopped,
}: {
  readonly iframe: HTMLIFrameElement
  readonly url: string
  readonly code: FrameCode
  readonly viewer?: string | undefined
  readonly hear: (data: unknown) => void
  readonly stopped: () => void
}): OpenFrame => {
  let port: MessagePort | undefined
  let closed = false
  let loads = 0
  const close = (): void => {
    closed = true
    port?.close()
    port = undefined
  }
  iframe.addEventListener("load", () => {
    loads += 1
    if (closed) return
    if (loads > 1) {
      close()
      return stopped()
    }
    const target = iframe.contentWindow
    codeOf(code).then(
      ({ scripts, worker }) => {
        if (closed || !target || loads > 1) return
        const channel = new MessageChannel()
        port = channel.port1
        port.addEventListener("message", ({ data }) => hear(data))
        port.start()
        const all = viewer === undefined ? scripts : [...scripts, `self.frameViewer = ${viewer}`]
        // Its origin is opaque, so "*" is the only one to name; the page checks its parent sent it.
        target.postMessage({ type: "start", scripts: all, worker }, "*", [channel.port2])
      },
      // The code couldn't be had, as a chunk that didn't load: the next frame tries again.
      () => {
        known.delete(code)
        close()
        stopped()
      },
    )
  })
  iframe.src = url
  return {
    post: (message, transfer = []) => {
      if (!closed) port?.postMessage(message, transfer)
    },
    close,
  }
}
