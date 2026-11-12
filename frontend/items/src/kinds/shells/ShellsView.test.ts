import type { Companions, ItemContent, ShellEntry } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach } from "vitest"

import { TellContext } from "../../homes/terminal/tell"
import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { ShellsView } from "./ShellsView"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }
const item = itemFixture("shells", "01", { kind: "shells", name: "Shells", path: null })
const now = Date.now()

const tail = (lines: string[], firstLine = 1): ShellEntry["output"] => ({
  state: "ready",
  firstLine,
  lines,
  total: firstLine - 1 + lines.length,
})
const shell = (id: string, fields: Partial<ShellEntry> = {}): ShellEntry => ({
  id,
  command: `cmd ${id}`,
  since: now - 12 * 60_000,
  exit: null,
  output: tail(["one", "two", "three", "four"]),
  ...fields,
})

const shown = async (
  shells: ShellEntry[],
  tell?: (words: string) => void,
  content: ItemContent = {
    state: "ready",
    stamp: "1",
    content: { kind: "shells", agent: "Codex", shells },
  },
) => {
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      on(content)
      return () => {}
    },
    save: () => Promise.reject(new Error("no")),
    trouble: () => {},
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const { container, unmount } = await render(
    createElement(
      TellContext.Provider,
      { value: tell },
      createElement(ShellsView, { itemStore, target, item, actions: undefined }),
    ),
  )
  unmounts.push(unmount)
  return { container, itemStore }
}

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll(".shells-row")].map((row) => ({
    command: row.querySelector(".shells-command")!.textContent,
    state: row.querySelector(".shells-state")!.textContent,
    lines: row.querySelectorAll(".shells-line").length,
    note: row.querySelector(".shells-note")?.textContent ?? null,
  }))

describe("the shells item", () => {
  context("with shells in every state", () => {
    it("lists failed first, then running, then the ended, each with its state and last lines", async () => {
      const { container } = await shown([
        shell("ok", { exit: { at: now, code: 0 } }),
        shell("run", { since: now - 60_000 }),
        shell("bad", { exit: { at: now, code: 1 } }),
        shell("stop", { exit: { at: now - 1000, code: null } }),
      ])
      expect(rows(container).map(({ command, state, lines }) => [command, state, lines])).toEqual([
        ["cmd bad", "exited 1", 3],
        ["cmd run", "1m", 3],
        ["cmd ok", "exited 0", 3],
        ["cmd stop", "stopped", 3],
      ])
      expect(container.querySelector(".shells-meta, .artifact-meta")!.textContent).toContain(
        "1 running · 1 failed · 2 ended",
      )
    })
  })

  context("when one is unfolded", () => {
    it("shows its whole tail and the others' last line, and a running one follows its end", async () => {
      const { container } = await shown([shell("a"), shell("b")])
      const toggle = container.querySelectorAll<HTMLButtonElement>(".shells-toggle")[0]!
      await act(async () => toggle.click())
      expect(rows(container).map((row) => row.lines)).toEqual([4, 1])
      expect(container.querySelector(".shells-foot")!.textContent).toContain("Following the end")
      await act(async () => container.querySelector<HTMLButtonElement>(".shells-pause")!.click())
      expect(container.querySelector(".shells-foot")!.textContent).toContain("Paused")
      await act(async () => toggle.click())
      expect(rows(container).map((row) => row.lines)).toEqual([3, 3])
    })
  })

  context("when a shell failed", () => {
    it("offers to tell the agent where the chat can take a draft, which is drafted and never sent", async () => {
      const drafts: string[] = []
      const bad = shell("bad", { exit: { at: now, code: 2 }, output: tail(["x", "boom"]) })
      const { container } = await shown([bad], (words) => drafts.push(words))
      const button = container.querySelector<HTMLButtonElement>(".shells-tell")!
      expect(button.textContent).toBe("Tell Codex")
      await act(async () => button.click())
      expect(drafts).toEqual(["`cmd bad` exited 2. The end of its output:\n\nx\nboom"])
    })

    it("offers nothing where there is no chat to draft in", async () => {
      const { container } = await shown([shell("bad", { exit: { at: now, code: 2 } })])
      expect(container.querySelector(".shells-tell")).toBeNull()
    })
  })

  context("when its output can't be shown", () => {
    it("says plainly that Novadeck can't read it, or that it is gone", async () => {
      const { container } = await shown([
        shell("none", { output: { state: "none" } }),
        shell("gone", { output: { state: "gone" }, exit: { at: now, code: 0 } }),
      ])
      const [none, gone] = rows(container)
      expect(none!.note).toContain("Codex ran this in a terminal of its own")
      expect(gone!.note).toBe("Its output is gone: Codex cleared it with its session.")
    })

    it("says so for a shell that printed nothing yet", async () => {
      const { container } = await shown([shell("quiet", { output: tail([]) })])
      expect(rows(container)[0]!.note).toBe("No output yet.")
    })
  })

  context("without shells, or once the runner took the item away", () => {
    it("says there are none, or that they are gone", async () => {
      expect((await shown([])).container.textContent).toContain(
        "Codex has no background shells now.",
      )
      const missing = await shown([], undefined, {
        state: "unavailable",
        reason: "missing",
        size: null,
      })
      expect(missing.container.textContent).toContain("The shells are gone.")
    })
  })
})
