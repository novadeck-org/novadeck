import { describe, expect, it } from "../../test"
import { createWebview } from "./webview"

describe("a live page's view", () => {
  it("is made with the pages' session and allowpopups as attributes, before it loads", () => {
    const view = createWebview("http://localhost:5173/")
    expect(view.tagName).toBe("WEBVIEW")
    expect(view.isConnected).toBe(false)
    expect(view.getAttribute("partition")).toBe("novadeck-pages")
    // Electron reads it only as an attribute, as the view attaches.
    expect(view.getAttribute("allowpopups")).toBe("")
    expect(view.getAttribute("src")).toBe("http://localhost:5173/")
    expect(view.className).toBe("artifact-webview")
  })
})
