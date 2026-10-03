import { afterEach, beforeEach, vi } from "vitest"

import {
  companionKeyId,
  emptyCompanions,
  type Companions,
  type ItemContent,
  type ItemId,
  type PlanSaved,
  type PlanVersion,
} from "../../model/companion"
import { messagesKey } from "../../model/companion-bar"
import { noMail, type MailState } from "../../model/messages"
import { activeSession, workspaceReducer, type WorkspaceAction } from "../../model/state"
import { createStore, createWorkspaceStore, type WorkspaceStore } from "../../model/store"
import { context, describe, expect, it } from "../../test"
import { itemFixture, workspaceFixture } from "../../test/fixtures"
import { createPanes, type PlanActions } from "./state"

const target = { projectId: "project", workspaceSessionId: "initial" }
const planItem = itemFixture("plan", "01", {
  kind: "plan",
  name: "Plan",
  path: "plan.md",
  plan: { agent: "Codex", role: "root", source: "file" },
})
const hero = itemFixture("hero", "01", { kind: "image", name: "hero.png", path: "/p/hero.png" })
const first = "# Plan\n\nalpha\nbeta\ngamma\n"

const snapshot = (text: string, stamp: string, writable = true): PlanVersion => ({
  stamp,
  plan: { kind: "plan", text, truncated: false, writable, skill: true },
})
const contentOf = ({ stamp, plan }: PlanVersion): ItemContent => ({
  state: "ready",
  stamp,
  content: plan,
})

// The session's terminal 01 holds a plan and an image.
const workspaceWith = (): WorkspaceStore =>
  createWorkspaceStore(
    [planItem, hero]
      .map((item): WorkspaceAction => ({ type: "item/upsert", target, item }))
      .reduce(workspaceReducer, workspaceFixture()),
  )

// A backend the test drives: it answers saves when told to, reports the plan's versions
// it's given, and counts what's followed.
const backend = () => {
  const listeners = new Map<ItemId, (content: ItemContent) => void>()
  const follows: { readonly id: ItemId; readonly reveal: boolean }[] = []
  const stopped: ItemId[] = []
  const saves: {
    readonly text: string
    readonly basedOn: string
    readonly answer: (result: PlanSaved) => void
    readonly fail: () => void
  }[] = []
  const companions: Companions = {
    follow: (_target, id, { reveal }, on) => {
      follows.push({ id, reveal })
      listeners.set(id, on)
      on(
        id === planItem.id
          ? contentOf(snapshot(first, "1"))
          : { state: "unavailable", reason: "held", size: null },
      )
      return () => {
        stopped.push(id)
        if (listeners.get(id) === on) listeners.delete(id)
      }
    },
    save: (_target, _id, text, basedOn) =>
      new Promise((resolve, reject) =>
        saves.push({ text, basedOn, answer: resolve, fail: () => reject(new Error("down")) }),
      ),
  }
  return {
    companions,
    saves,
    follows,
    stopped,
    emit: (version: PlanVersion) => listeners.get(planItem.id)?.(contentOf(version)),
  }
}

// The panes following `companions` from now on, over a workspace holding the plan.
const connected = (companions: Companions, workspace = workspaceWith()) => {
  const panes = createPanes({ companions, workspace })
  panes.connect()
  const actions: PlanActions = panes.plan(target, planItem.id)
  const plan = () => panes.store.getSnapshot().plans[planItem.id]!
  return { panes, actions, plan, workspace }
}

// Lets pending answers, and the merge code's lazy import, finish.
const settle = async () => {
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("companion store", () => {
  context("when an agent's rewrite arrives while a save is under way", () => {
    it("waits for the save's answer and merges over it, so the user's edit stays once", async () => {
      const { companions, saves, emit } = backend()
      const { actions, plan } = connected(companions)
      const edited = first.replace("beta\n", "beta\nUSER LINE\n")
      actions.edit(edited, [])
      actions.flush()
      expect(saves).toHaveLength(1)
      // The agent wrote over the saved text before the save's answer came back.
      emit(snapshot(edited.replace("gamma", "GAMMA (agent)"), "3"))
      await settle()
      saves[0]!.answer({ saved: true, stamp: "2" })
      await settle()
      expect(plan().text).toBe("# Plan\n\nalpha\nbeta\nUSER LINE\nGAMMA (agent)\n")
      expect(plan()).toMatchObject({ revision: "3", showChanges: true })
      expect(saves).toHaveLength(1)
    })

    it("takes the save coming back as the user's own, not a rewrite", async () => {
      const { companions, saves, emit } = backend()
      const { actions, plan } = connected(companions)
      const edited = `${first}No blog.\n`
      actions.edit(edited, [])
      actions.flush()
      emit(snapshot(edited, "2"))
      await settle()
      saves[0]!.answer({ saved: true, stamp: "2" })
      await settle()
      expect(plan()).toMatchObject({ text: edited, base: edited, showChanges: false })
    })
  })

  it("applies a rewrite that kept the revision name but changed the text", async () => {
    const { companions, emit } = backend()
    const { plan } = connected(companions)
    emit(snapshot(first.replace("alpha", "ALPHA"), "1"))
    await settle()
    expect(plan().text).toContain("ALPHA")
  })

  it("merges a refused save into the file as it stands, and saves the rest again", async () => {
    const { companions, saves } = backend()
    const { actions, plan } = connected(companions)
    actions.edit(`${first}No blog.\n`, [])
    actions.flush()
    saves[0]!.answer({ saved: false, current: snapshot(first.replace("alpha", "ALPHA"), "5") })
    await settle()
    expect(plan().text).toBe("# Plan\n\nALPHA\nbeta\ngamma\nNo blog.\n")
    expect(saves[1]).toMatchObject({
      basedOn: "5",
      text: "# Plan\n\nALPHA\nbeta\ngamma\nNo blog.\n",
    })
  })

  it("tries a failed save again, less often each time, and says the plan isn't saved", async () => {
    const { companions, saves } = backend()
    const { actions, plan } = connected(companions)
    actions.edit(`${first}No blog.\n`, [])
    actions.flush()
    saves[0]!.fail()
    await settle()
    expect(plan().unsaved).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves).toHaveLength(2)
    saves[1]!.answer({ saved: true, stamp: "2" })
    await settle()
    expect(plan()).toMatchObject({ unsaved: false, revision: "2" })
  })

  it("stops saying a plan isn't saved once there's nothing left to save", async () => {
    const { companions, saves } = backend()
    const { actions, plan } = connected(companions)
    actions.edit(`${first}No blog.\n`, [])
    actions.flush()
    saves[0]!.fail()
    await settle()
    expect(plan().unsaved).toBe(true)
    actions.edit(first, [])
    actions.flush()
    expect(plan().unsaved).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(saves).toHaveLength(1)
  })

  it("counts a save that never answers as failed, and ignores its late answer", async () => {
    const { companions, saves } = backend()
    const { actions, plan } = connected(companions)
    actions.edit(`${first}No blog.\n`, [])
    actions.flush()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(plan().unsaved).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves).toHaveLength(2)
    saves[0]!.answer({ saved: true, stamp: "late" })
    saves[1]!.answer({ saved: true, stamp: "2" })
    await settle()
    expect(plan()).toMatchObject({ unsaved: false, revision: "2" })
  })

  context("when a save timed out but was written", () => {
    it("merges a rewrite over it, so the user's edit stays once", async () => {
      const { companions, saves, emit } = backend()
      const { actions, plan } = connected(companions)
      const edited = first.replace("beta\n", "beta\nUSER LINE\n")
      actions.edit(edited, [])
      actions.flush()
      emit(snapshot(edited.replace("gamma", "GAMMA (agent)"), "3"))
      await vi.advanceTimersByTimeAsync(20_000)
      await settle()
      expect(plan().text).toBe("# Plan\n\nalpha\nbeta\nUSER LINE\nGAMMA (agent)\n")
      saves[0]!.answer({ saved: true, stamp: "2" })
      await settle()
      expect(plan().text.split("USER LINE")).toHaveLength(2)
    })

    it("keeps the user's edit when the save never reached the file", async () => {
      const { companions, saves, emit } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(first.replace("beta\n", "beta\nUSER LINE\n"), [])
      actions.flush()
      saves[0]!.fail()
      await settle()
      emit(snapshot(first.replace("gamma", "GAMMA"), "3"))
      await settle()
      expect(plan().text).toBe("# Plan\n\nalpha\nbeta\nUSER LINE\nGAMMA\n")
    })

    it("takes the file refusing a retry with that save's text as the user's own", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}ONE\n`, [])
      actions.flush()
      await vi.advanceTimersByTimeAsync(20_000)
      actions.edit(`${first}ONE\nTWO\n`, [])
      await vi.advanceTimersByTimeAsync(2000)
      saves[1]!.answer({ saved: false, current: snapshot(`${first}ONE\n`, "2") })
      await settle()
      expect(plan()).toMatchObject({
        text: `${first}ONE\nTWO\n`,
        showChanges: false,
        revision: "2",
      })
      expect(saves[2]).toMatchObject({ basedOn: "2", text: `${first}ONE\nTWO\n` })
    })
  })

  it("takes no edits to a plan the backend can't write, and never saves it", async () => {
    const { companions, saves, emit } = backend()
    const { actions, plan } = connected(companions)
    emit(snapshot(first, "2", false))
    await settle()
    actions.edit(`${first}No blog.\n`, [])
    actions.flush()
    expect(plan()).toMatchObject({ text: first, writable: false })
    expect(saves).toHaveLength(0)
  })

  it("saves once typing pauses", async () => {
    const { companions, saves } = backend()
    const { actions } = connected(companions)
    actions.edit(`${first}N`, [])
    actions.edit(`${first}No`, [])
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(saves.map((save) => save.text)).toEqual([`${first}No`])
  })

  it("keeps the file's line breaks when saving", async () => {
    const crlf = first.replaceAll("\n", "\r\n")
    const { companions, saves, emit } = backend()
    const { actions, plan } = connected(companions)
    emit(snapshot(crlf, "2"))
    await settle()
    actions.edit(`${plan().text}No blog.\n`, [])
    actions.flush()
    expect(saves[0]!.text).toBe(`${crlf}No blog.\r\n`)
  })
})

describe("following items", () => {
  it("follows every plan, and something else only while it's watched", () => {
    const { companions, follows, stopped } = backend()
    const { panes } = connected(companions)
    expect(follows).toEqual([{ id: planItem.id, reveal: false }])
    const release = panes.watch(target, hero.id)
    const again = panes.watch(target, hero.id)
    expect(follows.map((each) => each.id)).toEqual([planItem.id, hero.id])
    expect(panes.store.getSnapshot().content[hero.id]).toMatchObject({ reason: "held" })
    release()
    expect(stopped).toEqual([])
    again()
    expect(stopped).toEqual([hero.id])
    // What it held goes with the last place showing it.
    expect(panes.store.getSnapshot().content).not.toHaveProperty(hero.id)
  })

  it("follows again, revealed, once the person asks to see what may hold secrets", () => {
    const { companions, follows } = backend()
    const { panes } = connected(companions)
    panes.watch(target, hero.id)
    panes.reveal(target, hero.id)
    expect(follows.at(-1)).toEqual({ id: hero.id, reveal: true })
    expect(panes.store.getSnapshot().revealed).toEqual({ [hero.id]: true })
  })

  it("forgets a gone plan's failed saves, so one put back starts afresh", async () => {
    const { companions, saves } = backend()
    const { actions, workspace } = connected(companions)
    actions.edit(`${first}No blog.\n`, [])
    actions.flush()
    saves[0]!.fail()
    await settle()
    workspace.dispatch({ type: "item/close", target, itemId: planItem.id })
    // The runner refused the close: the plan is back, and its save fails once more.
    workspace.dispatch({ type: "item/upsert", target, item: planItem })
    await settle()
    actions.edit(`${first}Later.\n`, [])
    actions.flush()
    saves.at(-1)!.fail()
    await settle()
    const sent = saves.length
    // A first failure waits two seconds before trying again, not four.
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves.length).toBe(sent + 1)
  })

  it("stops following what's gone, and forgets it", () => {
    const { companions, stopped } = backend()
    const { panes, workspace } = connected(companions)
    workspace.dispatch({ type: "item/close", target, itemId: planItem.id })
    expect(stopped).toEqual([planItem.id])
    expect(panes.store.getSnapshot().plans).toEqual({})
  })
})

describe("a terminal's messages on its taskbar", () => {
  const mailOf = (count: number): MailState => ({
    ...noMail,
    terminals: {
      [companionKeyId({ ...target, terminalId: "01" })]: {
        handle: "t1",
        agent: true,
        threads: [
          {
            id: "th",
            peer: "t2",
            hops: count,
            allowed: 4,
            held: false,
            messages: Array.from({ length: count }, (_, index) => ({
              id: `m${index}`,
              hop: index + 1,
              from: "t2",
              to: "t1",
              text: "Ready",
              sentAt: 0,
              state: "delivered" as const,
              held: null,
              deliveredAt: 0,
            })),
          },
        ],
      },
    },
  })
  const following = (mail: MailState) => {
    const state = createStore(mail)
    const workspace = createWorkspaceStore(workspaceFixture())
    const panes = createPanes({
      companions: emptyCompanions(),
      workspace,
      messages: { state, pause: () => {}, release: () => {} },
    })
    panes.connect()
    const bar = () => activeSession(workspace.getSnapshot())!.state.bars["01"]
    const hide = () =>
      workspace.dispatch({ type: "bar/hide", target, terminalId: "01", key: messagesKey })
    return { state, bar, hide }
  }

  it("join the bar's order once the terminal has them", () => {
    expect(following(mailOf(0)).bar()?.order).toEqual([messagesKey])
  })

  it("join the bar's order with the first message, after an agent with none", () => {
    const { state, bar } = following({
      ...noMail,
      terminals: {
        [companionKeyId({ ...target, terminalId: "01" })]: {
          handle: "t1",
          agent: false,
          threads: [],
        },
      },
    })
    expect(bar()).toBeUndefined()
    state.update(() => mailOf(1))
    expect(bar()?.order).toEqual([messagesKey])
  })

  it("stay off the bar while hidden, whatever else changes", () => {
    const { state, bar, hide } = following(mailOf(1))
    hide()
    state.update((mail) => ({ ...mail, paused: true }))
    expect(bar()).toMatchObject({ hidden: [messagesKey], order: [] })
  })

  it("come back with the next message once hidden, whether the terminal is on screen or not", () => {
    const { state, bar, hide } = following(mailOf(1))
    hide()
    state.update(() => mailOf(1))
    expect(bar()?.hidden).toEqual([messagesKey])
    state.update(() => mailOf(2))
    expect(bar()).toMatchObject({ hidden: [], order: [messagesKey] })
  })
})
