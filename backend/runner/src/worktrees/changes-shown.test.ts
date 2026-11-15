import { vi } from "vitest"

import type { TerminalPlace } from "../companions/items.js"
import { logs, useLogger } from "../log.js"
import { describe, expect, it } from "../test.js"
import { keepWorktreeChanges, type ChangesShownHost } from "./changes-shown.js"
import type { Made, WorktreeChange } from "./worktrees.js"

const place = (terminalId: string) => ({ terminalId }) as unknown as TerminalPlace

const host = (overrides: Partial<ChangesShownHost> = {}) => {
  let made: ((made: Made) => void) | undefined
  let changed: ((change: WorktreeChange) => void) | undefined
  const show = vi.fn<ChangesShownHost["show"]>(async () => undefined)
  const closeOn = vi.fn<ChangesShownHost["closeOn"]>()
  const closeAll = vi.fn<ChangesShownHost["closeAll"]>()
  const stop = keepWorktreeChanges({
    onMade: (listener) => {
      made = listener
      return () => {
        made = undefined
      }
    },
    onChanged: (listener) => {
      changed = listener
      return () => {
        changed = undefined
      }
    },
    enabled: () => true,
    owner: (root) => (root === "/w/orphan" ? null : "owner"),
    place: (terminalId) => (terminalId === "closed" ? undefined : place(terminalId)),
    show,
    closeOn,
    closeAll,
    ...overrides,
  })
  return {
    show,
    closeOn,
    closeAll,
    stop,
    make: (root: string) => made?.({ root, projectId: "p" }),
    change: (change: WorktreeChange) => changed?.(change),
    listening: () => made !== undefined || changed !== undefined,
  }
}

describe("a worktree's changes on its owner's bar", () => {
  it("are shown once it is opened or adopted, one item per worktree", () => {
    const { show, make } = host()
    make("/w/one")
    make("/w/two")
    expect(show.mock.calls).toEqual([
      [place("owner"), "/w/one"],
      [place("owner"), "/w/two"],
    ])
  })

  it("move to the new owner's bar when it changes hands", () => {
    const { show, closeOn, change } = host()
    change({ type: "moved", root: "/w/one", from: "lead", to: "worker" })
    expect(closeOn.mock.calls).toEqual([["lead", "/w/one"]])
    expect(show.mock.calls).toEqual([[place("worker"), "/w/one"]])
    // One with no owner before has no bar to leave.
    change({ type: "moved", root: "/w/two", from: null, to: "worker" })
    expect(closeOn).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledTimes(2)
  })

  it("close everywhere once it is gone, whether agent worktrees are on or not", () => {
    const on = host()
    on.change({ type: "removed", root: "/w/one" })
    expect(on.closeAll.mock.calls).toEqual([["/w/one"]])
    const off = host({ enabled: () => false })
    off.change({ type: "removed", root: "/w/one" })
    expect(off.closeAll).toHaveBeenCalledOnce()
  })

  it("aren't shown while agent worktrees are off, or with no owner's bar to show them on", () => {
    const off = host({ enabled: () => false })
    off.make("/w/one")
    off.change({ type: "moved", root: "/w/one", from: "lead", to: "worker" })
    expect(off.show).not.toHaveBeenCalled()
    const lacking = host()
    lacking.make("/w/orphan")
    lacking.change({ type: "moved", root: "/w/one", from: "lead", to: "closed" })
    expect(lacking.show).not.toHaveBeenCalled()
  })

  it("log a show that fails, and stop when told", async ({ resources }) => {
    const lines: string[] = []
    const before = logs.current()
    const note = (evt: string) => {
      lines.push(evt)
    }
    useLogger({
      for: () => ({ debug: note, info: note, warn: note, error: note, fatal: note }),
      flush: () => {},
      close: () => {},
    })
    resources.defer(() => useLogger(before))
    host({ show: () => Promise.resolve({ ok: false, reason: "no git" }) }).make("/w/one")
    const throwing = host({ show: () => Promise.reject(new Error("gone")) })
    throwing.make("/w/one")
    await vi.waitFor(() =>
      expect(lines).toEqual(["worktrees.changes-unshown", "worktrees.changes-unshown"]),
    )
    throwing.stop()
    expect(throwing.listening()).toBe(false)
  })
})
