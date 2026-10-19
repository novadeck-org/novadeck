import { linkHint, linkOptions, linkTitle, opensLink, webLink } from "./links"
import { context, describe, expect, it } from "./test"

const click = (
  keys: Partial<Pick<MouseEvent, "button" | "ctrlKey" | "metaKey">> = {},
): MouseEvent => new MouseEvent("click", keys)

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

  context("opened from a terminal", () => {
    const linked = () => {
      const opened: string[] = []
      const links = linkOptions({ platform: "other", open: (url) => opened.push(url) })
      return { opened, links }
    }

    it("open the page on the platform's click", () => {
      const { opened, links } = linked()
      links.open("https://example.com", click({ ctrlKey: true }))
      expect(opened).toEqual(["https://example.com/"])
    })

    it("show where they go on hover, whatever their text says", () => {
      expect(linked().links.title?.("https://elsewhere.example/login")).toBe(
        "https://elsewhere.example/login\nCtrl-click to open",
      )
    })

    it("stay closed on a plain click or another scheme", () => {
      const { opened, links } = linked()
      links.open("https://example.com", click())
      links.open("file:///etc/passwd", click({ ctrlKey: true }))
      expect(opened).toEqual([])
    })
  })
})
