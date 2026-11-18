import { asClassic } from "./classic.js"

// Starts the PDF viewer's frame (frame.html) in `iframe`, which its caller makes and
// sandboxes: once its page has loaded, hands it pdf.js, pdf.js's worker and the viewer as
// text, with one end of a channel; everything the frame says after comes over the channel's
// other end, to `hear`, unchecked (the caller checks it). The page's own script takes only
// this one message, and only from its parent. Should the frame load another page after its
// own, which only a script in it could make it do, `stopped` is called and it hears nothing
// more.

export type FrameCode = () => Promise<{ readonly library: string; readonly worker: string }>

// pdf.js as the frame runs it, converted once for every frame.
const converted = new WeakMap<FrameCode, Promise<{ library: string; worker: string }>>()
const codeOf = (code: FrameCode) => {
  const known =
    converted.get(code) ??
    code().then(({ library, worker }) => ({
      library: asClassic(library, "pdfjsLib"),
      worker: asClassic(worker, "pdfjsWorker"),
    }))
  converted.set(code, known)
  return known
}

export type OpenFrame = {
  readonly post: (message: Record<string, unknown>, transfer?: Transferable[]) => void
  readonly close: () => void
}

export const openPdfFrame = ({
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
  readonly viewer: string
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
    void codeOf(code).then(({ library, worker }) => {
      if (closed || !target || loads > 1) return
      const channel = new MessageChannel()
      port = channel.port1
      port.addEventListener("message", ({ data }) => hear(data))
      port.start()
      // Its origin is opaque, so "*" is the only one to name; the page checks its parent sent it.
      target.postMessage({ type: "start", library, worker, viewer }, "*", [channel.port2])
    })
  })
  iframe.src = url
  return {
    post: (message, transfer = []) => {
      if (!closed) port?.postMessage(message, transfer)
    },
    close,
  }
}
