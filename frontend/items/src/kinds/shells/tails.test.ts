import type { Companions, ItemContent, ShellEntry } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { afterEach } from "vitest"

import { createItemStore } from "../../store/item-store"
import { describe, expect, it } from "../../test"
import { shellTailsOf } from "./tails"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }
const item = itemFixture("shells", "01", { kind: "shells", name: "Shells", path: null })

const shell = (id: string, lines: string[]): ShellEntry => ({
  id,
  command: `cmd ${id}`,
  since: 0,
  exit: null,
  output: { state: "ready", firstLine: 1, lines, total: lines.length },
})
const contentOf = (...shells: ShellEntry[]): ItemContent => ({
  state: "ready",
  stamp: shells.map(({ output }) => JSON.stringify(output)).join(),
  content: { kind: "shells", agent: "Claude", shells },
})

describe("the last lines the chat shows under its shell lines", () => {
  it("are one record, which stays the same while no last line changed", () => {
    let push: (content: ItemContent) => void = () => {}
    const companions: Companions = {
      follow: (_target, _id, _options, on) => {
        push = on
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
    const tails = shellTailsOf(itemStore, target, item)
    unmounts.push(tails.watch())
    expect(tails.snapshot()).toEqual({})
    push(contentOf(shell("a", ["one", " "]), shell("b", [])))
    const first = tails.snapshot()
    expect(first).toEqual({ a: "one" })
    // Earlier lines moved and a blank came, but the last line that says something is the same.
    push(contentOf(shell("a", ["zero", "one", ""]), shell("b", [])))
    expect(tails.snapshot()).toBe(first)
    push(contentOf(shell("a", ["one", "two"]), shell("b", ["x"])))
    expect(tails.snapshot()).toEqual({ a: "two", b: "x" })
  })
})
