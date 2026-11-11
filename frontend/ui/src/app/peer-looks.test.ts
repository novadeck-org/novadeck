import { hueOf } from "@novadeck/items/critters"
import { render } from "@novadeck/test-kit/render"
import { createElement, Fragment } from "react"

import { describe, expect, it } from "../test"
import { peerLooksOf } from "./peer-looks"

describe("peerLooksOf", () => {
  const looks = peerLooksOf({
    moth: { name: "Checkout review", terminalId: "t1", program: "codex", live: "working" },
    kite: { name: "Runtime", terminalId: "t2", program: undefined, live: "gone" },
  })

  it("gives a peer the Messages pane's avatar, its hue and where it runs", () => {
    const look = looks("moth")!
    expect(look.where).toBe("codex · Checkout review")
    expect(look.hue).toBe(hueOf("moth"))
    const { container, unmount } = render(createElement(Fragment, null, look.face))
    const face = container.querySelector(".message-av")
    expect(face?.getAttribute("data-live")).toBe("working")
    expect(face?.getAttribute("data-hue")).toBe(String(hueOf("moth")))
    unmount()
  })

  it("says only the terminal where the program isn't known", () => {
    expect(looks("kite")?.where).toBe("Runtime")
  })

  it("has no look for a handle no terminal answers to", () => {
    expect(looks("owl")).toBeNull()
  })

  it("has no look for a word of Object's own, as `@constructor`", () => {
    for (const word of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(looks(word)).toBeNull()
    }
  })
})
