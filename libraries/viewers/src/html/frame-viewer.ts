import { buildPage, type PageFile } from "./page.js"

// The web page viewer as it runs in its frame (frame/frame.html), never in the app's page: it
// takes the page's text and the files beside it that the app read over the port, builds the
// page from them (page.ts) and draws it in a child frame of its own that runs nothing: the
// frame's policy allows no script but its own, no network and no frame in the page, so what a
// page asks for beyond the files it was given is never fetched. It says only that it's ready
// and whether it's drawing. A page written again is drawn in a new child while the old one
// stays in view, and swapped in once it has loaded.

type Open = {
  readonly type: "open"
  readonly html: string
  readonly files: readonly { readonly name: string; readonly bytes: ArrayBuffer }[]
}

const isOpen = (message: Record<string, unknown>): message is Open =>
  typeof message.html === "string" &&
  Array.isArray(message.files) &&
  message.files.every(
    (file: unknown) =>
      typeof (file as { name?: unknown } | null)?.name === "string" &&
      (file as { bytes?: unknown }).bytes instanceof ArrayBuffer,
  )

export const htmlFrameViewer = ({ port }: { readonly port: MessagePort }): void => {
  const tell = (message: Record<string, unknown>): void => port.postMessage(message)
  const style = document.createElement("style")
  style.textContent =
    "html,body{margin:0;height:100%;overflow:hidden;background:#fff}" +
    "iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}"
  document.head.append(style)

  let label = ""
  let shown: HTMLIFrameElement | undefined
  let latest = 0
  const open = (message: Open): void => {
    const at = (latest += 1)
    const files = new Map<string, PageFile>(
      message.files.map(({ name, bytes }) => [name, { name, bytes: new Uint8Array(bytes) }]),
    )
    const child = document.createElement("iframe")
    // Nothing the page does reaches past itself: no script, form, popup or navigation of the
    // frame above it, whatever the policy leaves.
    child.setAttribute("sandbox", "")
    child.title = label
    child.style.visibility = "hidden"
    tell({ type: "busy", busy: true })
    child.addEventListener(
      "load",
      () => {
        // A newer page was asked for while this one loaded: this one is dropped.
        if (at === latest) {
          shown?.remove()
          shown = child
          child.style.visibility = "visible"
        } else child.remove()
        if (at === latest) tell({ type: "busy", busy: false })
      },
      { once: true },
    )
    child.srcdoc = buildPage(message.html, files)
    document.body.append(child)
  }

  port.addEventListener("message", ({ data }) => {
    const message = data as { type: string } & Record<string, unknown>
    switch (message.type) {
      case "label":
        label = String(message.label)
        document.title = label
        if (shown) shown.title = label
        return
      case "open":
        if (isOpen(message)) open(message)
        return
    }
  })
  port.start()
  tell({ type: "ready" })
}
