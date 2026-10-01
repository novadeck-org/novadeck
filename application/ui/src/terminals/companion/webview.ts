// Electron's <webview>, as the pane uses it: its methods work once it's attached.
export type WebviewElement = HTMLWebViewElement & {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  getURL(): string
}

// Made here rather than by React, which leaves `allowpopups` off the element; Electron
// reads its attributes once, as it attaches. With it, a page's new windows reach the
// desktop app, which opens one in the browser right after the person's click or key.
// The app gives it the pages' session whatever it asks; it's named to match.
export const createWebview = (url: string): WebviewElement => {
  const element = document.createElement("webview") as WebviewElement
  element.className = "artifact-webview"
  element.setAttribute("partition", "novadeck-pages")
  element.setAttribute("allowpopups", "")
  element.setAttribute("src", url)
  return element
}
