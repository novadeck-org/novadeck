import { Terminal } from "@xterm/xterm"
import { vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { linkHint, linkTerminal, linkTitle, opensLink, webLink } from "./links"

// jsdom has no canvas or media queries; xterm opens without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

const click = (
  keys: Partial<Pick<MouseEvent, "button" | "ctrlKey" | "metaKey">> = {},
): MouseEvent => new MouseEvent("click", keys)

const range = { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } }

describe("terminal links", () => {
  context("on Apple platforms", () => {
    it("open on ⌘-click only", () => {
      expect(opensLink(click({ metaKey: true }), "mac")).toBe(true)
      expect(opensLink(click({ ctrlKey: true }), "mac")).toBe(false)
      expect(opensLink(click(), "mac")).toBe(false)
      expect(linkHint("mac")).toBe("⌘-click to open")
    })
  })

  context("elsewhere", () => {
    it("open on Ctrl-click only", () => {
      expect(opensLink(click({ ctrlKey: true }), "other")).toBe(true)
      expect(opensLink(click({ metaKey: true }), "other")).toBe(false)
      expect(opensLink(click(), "other")).toBe(false)
      expect(linkHint("other")).toBe("Ctrl-click to open")
    })
  })

  context("with another button", () => {
    it("stay closed", () => {
      expect(opensLink(click({ button: 1, ctrlKey: true }), "other")).toBe(false)
      expect(opensLink(click({ button: 2, ctrlKey: true }), "other")).toBe(false)
      expect(opensLink(click({ button: 2, metaKey: true }), "mac")).toBe(false)
    })
  })

  context("when hovered", () => {
    it("name the address they open and the click that opens it", () => {
      expect(linkTitle("https://example.com/a", "other")).toBe(
        "https://example.com/a\nCtrl-click to open",
      )
      expect(linkTitle("http://example.com", "mac")).toBe("http://example.com/\n⌘-click to open")
    })
  })

  context("by scheme", () => {
    it("leave the app only for web pages", () => {
      expect(webLink("https://example.com/a?b=1")).toBe("https://example.com/a?b=1")
      expect(webLink("http://localhost:5173")).toBe("http://localhost:5173/")
      expect(webLink("file:///etc/passwd")).toBeUndefined()
      expect(webLink("javascript:alert(1)")).toBeUndefined()
      expect(webLink("not a link")).toBeUndefined()
    })

    it("stay closed when they carry a login, which hides the host behind it", () => {
      expect(webLink("https://github.com%2Forg%2Frepo@elsewhere.example/")).toBeUndefined()
      expect(webLink("https://user:secret@example.com/")).toBeUndefined()
    })
  })

  context("printed as hyperlinks", () => {
    const linked = () => {
      const opened: string[] = []
      const xterm = new Terminal()
      linkTerminal(xterm, { platform: "other", open: (url) => opened.push(url) })
      const handler = xterm.options.linkHandler!
      return {
        opened,
        activate: (event: MouseEvent, text: string) => handler.activate(event, text, range),
      }
    }

    it("open the page on the platform's click", () => {
      const { opened, activate } = linked()
      activate(click({ ctrlKey: true }), "https://example.com")
      expect(opened).toEqual(["https://example.com/"])
    })

    it("show where they go on hover, whatever their text says", () => {
      const element = document.createElement("div")
      document.body.append(element)
      const xterm = new Terminal()
      linkTerminal(xterm, { platform: "other", open: () => {} })
      xterm.open(element)
      const handler = xterm.options.linkHandler!
      handler.hover!(click(), "https://elsewhere.example/login", range)
      expect(xterm.element?.getAttribute("title")).toBe(
        "https://elsewhere.example/login\nCtrl-click to open",
      )
      handler.leave!(click(), "https://elsewhere.example/login", range)
      expect(xterm.element?.hasAttribute("title")).toBe(false)
      xterm.dispose()
      element.remove()
    })

    it("stay closed on a plain click or another scheme", () => {
      const { opened, activate } = linked()
      activate(click(), "https://example.com")
      activate(click({ ctrlKey: true }), "file:///etc/passwd")
      expect(opened).toEqual([])
    })
  })
})
