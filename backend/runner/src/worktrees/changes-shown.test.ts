import { vi } from "vitest"

import type { TerminalPlace } from "../companions/items.js"
import type { ShowAnswer } from "../companions/request.js"
import { describe, expect, it } from "../test.js"
import { showWorktreeChanges, type ChangesShownHost } from "./changes-shown.js"
import type { Made } from "./worktrees.js"

const place = (terminalId: string) => ({ terminalId }) as unknown as TerminalPlace

const host = (overrides: Partial<ChangesShownHost> = {}) => {
  let listener: ((made: Made) => void) | undefined
  const show = vi.fn<ChangesShownHost["show"]>(
    async (): Promise<ShowAnswer> =>
      ({
        ok: true,
        id: "i",
        kind: "changes",
        name: "Changes",
        opened: false,
        again: false,
      }) as ShowAnswer,
  )
  const stop = showWorktreeChanges({
    onMade: (each) => {
      listener = each
      return () => {
        listener = undefined
      }
    },
    enabled: () => true,
    owner: (root) => (root === "/w/orphan" ? null : "owner"),
    place: (terminalId) => place(terminalId),
    show,
    ...overrides,
  })
  const made = (root: string) => listener?.({ root, projectId: "p" })
  return { show, made, stop, listening: () => listener !== undefined }
}

describe("a worktree an agent opens or adopts", () => {
  it("shows its changes on its owner's bar, not opened, one item per worktree", () => {
    const { show, made } = host()
    made("/w/one")
    made("/w/two")
    expect(show.mock.calls).toEqual([
      [place("owner"), { changes: { path: "/w/one" } }],
      [place("owner"), { changes: { path: "/w/two" } }],
    ])
  })

  it("shows nothing while agent worktrees are off, or with no owner's bar to show it on", () => {
    const off = host({ enabled: () => false })
    off.made("/w/one")
    expect(off.show).not.toHaveBeenCalled()
    const orphaned = host()
    orphaned.made("/w/orphan")
    expect(orphaned.show).not.toHaveBeenCalled()
    const closed = host({ place: () => undefined })
    closed.made("/w/one")
    expect(closed.show).not.toHaveBeenCalled()
  })

  it("lets a show that fails go, and stops listening when told", async () => {
    const { made, stop, listening } = host({
      show: () => Promise.reject(new Error("gone")),
    })
    made("/w/one")
    await Promise.resolve()
    stop()
    expect(listening()).toBe(false)
  })
})
