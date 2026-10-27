import type { InboxRow } from "@novadeck/core/inbox"
import { emptyCompanions, type Companions, type Item, type ItemContent } from "@novadeck/core/items"
import { createWorkspaceStore, type WorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { PlanTextProvider, usePlanText } from "./plan-text"

const target = { projectId: "project", workspaceSessionId: "initial" }
const asked = 1_000_000

const approval = (agent: InboxRow["source"]["agent"] = "claude"): InboxRow => ({
  id: "request:r",
  source: { ...target, terminalId: "01", handle: "moth", agent, title: "T", projectName: "P" },
  at: asked,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id: "r",
    kind: "plan",
    tool: "ExitPlanMode",
    subject: "Checkout plan",
    choices: [],
    subagent: false,
    dialog: null,
    answered: false,
  },
})

const planItem = (version: number, shownAt: number): Item =>
  itemFixture("plan", "01", {
    kind: "plan",
    name: "Checkout",
    path: "/home/me/.claude/plans/checkout.md",
    version,
    shownAt,
    plan: { agent: "Claude Code", role: "root", source: "file" },
  })

const ready = (text: string): ItemContent => ({
  state: "ready",
  stamp: text,
  content: { kind: "plan", text, truncated: false, writable: true, skill: true },
})

// Companions whose follows the test answers, each as it started: the latest last.
const following = () => {
  const follows: { itemId: string; on: (content: ItemContent) => void; stopped: boolean }[] = []
  const companions: Companions = {
    ...emptyCompanions(),
    follow: (_target, itemId, _options, on) => {
      const follow = { itemId, on, stopped: false }
      follows.push(follow)
      return () => {
        follow.stopped = true
      }
    },
  }
  const report = (content: ItemContent): void => act(() => follows.at(-1)!.on(content))
  return { companions, follows, report }
}

// What `usePlanText` says of `item`, rendered over `workspace`, as it changes.
const show = (
  workspace: WorkspaceStore,
  companions: Companions | undefined,
  item: InboxRow,
): { readonly text: () => string | null | undefined; readonly unmount: () => void } => {
  const Probe = (): React.JSX.Element => {
    const text = usePlanText(item)
    return createElement(
      "output",
      { "data-state": text === undefined ? "loading" : text === null ? "none" : "text" },
      text ?? "",
    )
  }
  const rendered = render(
    createElement(PlanTextProvider, { workspace, companions }, createElement(Probe)),
  )
  const text = (): string | null | undefined => {
    const output = rendered.container.querySelector("output")!
    const state = output.dataset["state"]
    return state === "loading" ? undefined : state === "none" ? null : output.textContent
  }
  return { text, unmount: rendered.unmount }
}

const upsert = (workspace: WorkspaceStore, item: Item): void =>
  act(() => {
    workspace.dispatch({ type: "item/upsert", target, item })
  })

describe("the plan text a plan approval's sheet shows", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(asked)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is the plan's Markdown once it loads, undefined until then", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    upsert(workspace, planItem(1, asked + 20))
    const { companions, follows, report } = following()
    const sheet = show(workspace, companions, approval())

    expect(sheet.text()).toBeUndefined()
    expect(follows.map(({ itemId }) => itemId)).toEqual(["plan"])
    report(ready("# Checkout\n\n1. Cart"))
    expect(sheet.text()).toBe("# Checkout\n\n1. Cart")
    sheet.unmount()
    expect(follows[0]!.stopped).toBe(true)
  })

  it("waits for a revised plan, never showing the round the person sent back", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    upsert(workspace, planItem(1, asked - 30_000))
    const { companions, follows, report } = following()
    const sheet = show(workspace, companions, approval())

    // The dialog came before its plan: the earlier round's isn't followed.
    expect(sheet.text()).toBeUndefined()
    expect(follows).toEqual([])

    upsert(workspace, planItem(2, asked + 20))
    expect(sheet.text()).toBeUndefined()
    report(ready("# Checkout, take two"))
    expect(sheet.text()).toBe("# Checkout, take two")
    sheet.unmount()
  })

  it("follows the plan anew when it is rewritten while the sheet shows it", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    upsert(workspace, planItem(1, asked))
    const { companions, follows, report } = following()
    const sheet = show(workspace, companions, approval())
    report(ready("# One"))

    upsert(workspace, planItem(2, asked + 5000))
    // What the first follow last said is the earlier version's.
    expect(follows[0]!.stopped).toBe(true)
    expect(sheet.text()).toBeUndefined()
    report(ready("# Two"))
    expect(sheet.text()).toBe("# Two")
    sheet.unmount()
  })

  it("is null once the wait for a plan that never came is over", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    const { companions } = following()
    const sheet = show(workspace, companions, approval())

    expect(sheet.text()).toBeUndefined()
    act(() => vi.advanceTimersByTime(5000))
    expect(sheet.text()).toBeNull()
    sheet.unmount()
  })

  it("takes a plan that comes after the wait is over", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    const { companions, report } = following()
    const sheet = show(workspace, companions, approval())
    act(() => vi.advanceTimersByTime(5000))
    expect(sheet.text()).toBeNull()

    act(() => vi.advanceTimersByTime(2000))
    upsert(workspace, planItem(1, asked + 7000))
    expect(sheet.text()).toBeUndefined()
    report(ready("# Late, but its own"))
    expect(sheet.text()).toBe("# Late, but its own")
    sheet.unmount()
  })

  it("is null where the plan can't be read, or the backend has no plans", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    upsert(workspace, planItem(1, asked))
    const { companions, report } = following()
    const sheet = show(workspace, companions, approval())
    report({ state: "unavailable", reason: "gone", size: null })
    expect(sheet.text()).toBeNull()
    sheet.unmount()

    const plain = show(workspace, undefined, approval())
    expect(plain.text()).toBeNull()
    plain.unmount()
  })

  it("is null for an item that is no plan approval, which follows nothing", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    upsert(workspace, planItem(1, asked))
    const { companions, follows } = following()
    const update: InboxRow = {
      ...approval(),
      kind: "update",
      update: { type: "done", subject: "Done", body: "" },
    } as InboxRow
    const sheet = show(workspace, companions, update)
    expect(sheet.text()).toBeNull()
    expect(follows).toEqual([])
    sheet.unmount()
  })
})
