import { messagePeers } from "@novadeck/core/derivations"
import { workspaceReducer } from "@novadeck/core/state"
import { workspaceFixture } from "@novadeck/core/testing"
import { hueOf } from "@novadeck/items/critters"
import { render, renderHook } from "@novadeck/test-kit/render"
import { createElement, Fragment } from "react"

import { describe, expect, it } from "../test"
import { peerLooksOf, usePeerMention } from "./peer-looks"

describe("peerLooksOf", () => {
  // The peers as the app derives them from the session: keyed by terminal id, read by handle.
  const target = { projectId: "project", workspaceSessionId: "initial" }
  const session = [
    { type: "terminal/update", terminalId: "01", handle: "moth" },
    { type: "terminal/rename", terminalId: "01", name: "Checkout review" },
    { type: "terminal/process", terminalId: "01", process: "codex" },
    {
      type: "terminal/status",
      terminalId: "01",
      status: { state: "running", agent: { working: true } },
    },
    { type: "terminal/update", terminalId: "02", handle: "kite" },
    { type: "terminal/rename", terminalId: "02", name: "Runtime" },
  ].reduce(
    (state, action) =>
      workspaceReducer(state, { ...action, target } as Parameters<typeof workspaceReducer>[1]),
    workspaceFixture({ terminals: 2 }),
  )
  const peers = messagePeers(session)
  const looks = peerLooksOf(peers)

  it("is keyed by terminal id, so a handle finds its peer through the handle", () => {
    expect(Object.keys(peers)).toEqual(["01", "02"])
    expect(looks("01")).toBeNull()
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

  it("has no look for words written before the terminal was given the handle", () => {
    const given = 5_000
    const later = peerLooksOf({
      ...peers,
      "01": { ...peers["01"]!, handleGivenAt: given },
    })
    expect(later("moth", given - 1)).toBeNull()
    expect(later("moth", given)?.hue).toBe(hueOf("moth"))
    // Words with no time, and a terminal whose handle was given long ago, are as they were.
    expect(later("moth")?.hue).toBe(hueOf("moth"))
    expect(later("moth", null)?.hue).toBe(hueOf("moth"))
    expect(later("kite", 1)?.hue).toBe(hueOf("kite"))
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

describe("usePeerMention", () => {
  const peer = (handle: string, handleGivenAt?: number) => ({
    name: handle,
    terminalId: `id-${handle}`,
    handle,
    ...(handleGivenAt !== undefined && { handleGivenAt }),
    program: undefined,
    live: "idle" as const,
  })
  const links = (...peers: ReturnType<typeof peer>[]) => {
    const snapshot = Object.fromEntries(peers.map((each) => [each.terminalId, each]))
    return {
      peers: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      goTo: () => {},
      answer: () => {},
    }
  }

  it("names an agent in words written at or after it was given the handle, not before", () => {
    const given = links(peer("moth"), peer("fox", 5_000))
    const { result, unmount } = renderHook(() => usePeerMention(given), null)
    const mention = result.current
    expect(mention("fox", 4_999)).toBeNull()
    expect(mention("fox", 5_000)).toBe(hueOf("fox"))
    // Words with no time, and a handle given long ago, are as they were.
    expect(mention("fox")).toBe(hueOf("fox"))
    expect(mention("moth", 1)).toBe(hueOf("moth"))
    expect(mention("owl", 9_999)).toBeNull()
    unmount()
  })
})
