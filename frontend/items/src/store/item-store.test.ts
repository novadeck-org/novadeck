import {
  PlanUnwritableError,
  type Companions,
  type Item,
  type ItemContent,
  type ItemId,
  type PlanSaved,
  type PlanUnwritableReason,
  type PlanVersion,
} from "@novadeck/core/items"
import { workspaceReducer, type WorkspaceAction } from "@novadeck/core/state"
import { createWorkspaceStore, type WorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { createItemStore, type PlanActions } from "./item-store"

const target = { projectId: "project", workspaceSessionId: "initial" }
const planItem = itemFixture("plan", "01", {
  kind: "plan",
  name: "Plan",
  path: "plan.md",
  plan: { agent: "Codex", role: "root", source: "file" },
})
const hero = itemFixture("hero", "01", { kind: "image", name: "hero.png", path: "/p/hero.png" })
const pointedHero = JSON.stringify(["image", "/p/hero.png"])
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
  const follows: { readonly id: ItemId; readonly reveal: string | undefined }[] = []
  const stopped: ItemId[] = []
  const saves: {
    readonly text: string
    readonly basedOn: string
    readonly answer: (result: PlanSaved) => void
    readonly fail: () => void
    readonly refuse: (reason: PlanUnwritableReason) => void
  }[] = []
  const companions: Companions = {
    follow: (_target, id, { reveal }, on) => {
      follows.push({ id, reveal })
      listeners.set(id, on)
      on(
        id === planItem.id
          ? contentOf(snapshot(first, "1"))
          : { state: "unavailable", reason: "secret", size: null },
      )
      return () => {
        stopped.push(id)
        if (listeners.get(id) === on) listeners.delete(id)
      }
    },
    trouble: () => {},
    save: (_target, _id, text, basedOn) =>
      new Promise((resolve, reject) =>
        saves.push({
          text,
          basedOn,
          answer: resolve,
          fail: () => reject(new Error("down")),
          refuse: (reason) => reject(new PlanUnwritableError(reason)),
        }),
      ),
  }
  return {
    companions,
    saves,
    follows,
    stopped,
    listeners,
    emit: (version: PlanVersion) => listeners.get(planItem.id)?.(contentOf(version)),
    emitContent: (content: ItemContent) => listeners.get(planItem.id)?.(content),
  }
}

// The item store following `companions` from now on, over a workspace holding the plan.
const connected = (companions: Companions, workspace = workspaceWith()) => {
  const itemStore = createItemStore({ companions, workspace })
  itemStore.connect()
  const actions: PlanActions = itemStore.plan(target, planItem.id)
  const plan = () => itemStore.store.getSnapshot().plans[planItem.id]!
  return { itemStore, actions, plan, workspace }
}

// Lets pending answers, and the merge code's lazy import, finish.
const settle = async () => {
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
}

// Fails the save that is under way, and waits out the pause before the next try.
const failAndWait = async (save: { readonly fail: () => void }, failures: number) => {
  save.fail()
  await settle()
  await vi.advanceTimersByTimeAsync(Math.min(30_000, 1000 * 2 ** failures))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the item store", () => {
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

  context("when the backend says a plan can never be written", () => {
    it("stops saving, keeps the edits, and says why", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      saves[0]!.refuse("folder")
      await settle()
      expect(plan()).toMatchObject({ blocked: "folder", unsaved: true, stalled: false })
      expect(plan().text).toBe(`${first}No blog.\n`)
      actions.edit(`${first}No blog.\nMore.\n`, [])
      actions.flush()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(saves).toHaveLength(1)
    })

    it("saves again when the person asks, clearing what stopped it once it works", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      saves[0]!.refuse("folder")
      await settle()
      actions.retry()
      expect(plan().blocked).toBeNull()
      expect(saves).toHaveLength(2)
      saves[1]!.answer({ saved: true, stamp: "2" })
      await settle()
      expect(plan()).toMatchObject({ blocked: null, unsaved: false, revision: "2" })
    })

    it("stops again when the second try is refused too", async () => {
      const { companions, saves, emitContent } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      saves[0]!.refuse("too-large")
      await settle()
      emitContent({ state: "unavailable", reason: "gone", size: null })
      actions.retry()
      saves[1]!.refuse("gone")
      await settle()
      expect(plan().blocked).toBe("gone")
      await vi.advanceTimersByTimeAsync(120_000)
      expect(saves).toHaveLength(2)
    })

    it("lets the edits go once nothing is left to save", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      saves[0]!.refuse("folder")
      await settle()
      actions.edit(first, [])
      actions.flush()
      expect(plan()).toMatchObject({ blocked: null, unsaved: false })
    })
  })

  context("when the file was put back while a save was refused as gone", () => {
    it("takes the refusal as a failure that may pass, and goes on with the new version", async () => {
      const { companions, saves, emit } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      // The agent deleted the plan and wrote it anew while the save was under way.
      emit(snapshot(first.replace("alpha", "ALPHA"), "3"))
      await settle()
      saves[0]!.refuse("gone")
      await settle()
      expect(plan().blocked).toBeNull()
      expect(plan().text).toContain("ALPHA")
      await vi.advanceTimersByTimeAsync(2000)
      expect(saves.length).toBeGreaterThan(1)
    })
  })

  context("when a save fails and the person keeps typing", () => {
    it("leaves the wait before the next try alone, so only spaced tries count", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}a\n`, [])
      actions.flush()
      saves[0]!.fail()
      await settle()
      for (const each of ["b", "c", "d", "e"]) {
        actions.edit(`${first}a${each}\n`, [])
        actions.flush()
        // eslint-disable-next-line no-await-in-loop -- Each pause follows the keystroke before.
        await vi.advanceTimersByTimeAsync(450)
      }
      expect(saves).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(300)
      expect(saves).toHaveLength(2)
      expect(saves[1]!.text).toBe(`${first}ae\n`)
      expect(plan().stalled).toBe(false)
    })

    it("tries again once the file reports, after saves gave up", async () => {
      const { companions, saves, emit } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      for (let each = 0; each < 5; each += 1)
        // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
        await failAndWait(saves[each]!, each + 1)
      expect(plan().stalled).toBe(true)
      emit(snapshot(first, "1"))
      await settle()
      expect(plan().stalled).toBe(false)
      expect(saves).toHaveLength(6)
    })
  })

  context("when a plan was too large", () => {
    it("saves again once the person edits it", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      saves[0]!.refuse("too-large")
      await settle()
      actions.edit(`${first}Short.\n`, [])
      expect(plan().blocked).toBeNull()
      await vi.advanceTimersByTimeAsync(400)
      expect(saves).toHaveLength(2)
    })

    it("takes no edits to a plan the runner says lives in messages", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      saves[0]!.refuse("transcript")
      await settle()
      actions.edit(`${first}More.\n`, [])
      expect(plan().text).toBe(`${first}No blog.\n`)
    })
  })

  context("when saves keep failing without a reason", () => {
    it("stops after five in a row, until the person retries", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      for (let each = 0; each < 5; each += 1) {
        expect(plan().stalled).toBe(false)
        // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
        await failAndWait(saves[each]!, each + 1)
      }
      expect(saves).toHaveLength(5)
      expect(plan()).toMatchObject({ stalled: true, unsaved: true, blocked: null })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(saves).toHaveLength(5)

      actions.retry()
      expect(plan().stalled).toBe(false)
      expect(saves).toHaveLength(6)
      // The count started over: four more failures still try again.
      for (let each = 5; each < 9; each += 1) {
        // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
        await failAndWait(saves[each]!, each - 4)
      }
      expect(saves).toHaveLength(10)
      expect(plan().stalled).toBe(false)
    })

    it("counts from the start after a save works", async () => {
      const { companions, saves } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      actions.flush()
      // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
      for (let each = 0; each < 4; each += 1) await failAndWait(saves[each]!, each + 1)
      saves[4]!.answer({ saved: true, stamp: "2" })
      await settle()
      actions.edit(`${first}No blog.\nMore.\n`, [])
      actions.flush()
      // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
      for (let each = 5; each < 9; each += 1) await failAndWait(saves[each]!, each - 4)
      expect(plan().stalled).toBe(false)
      expect(saves).toHaveLength(10)
    })
  })

  context("when the plan's file goes missing", () => {
    const gone: ItemContent = { state: "unavailable", reason: "gone", size: null }

    it("stops saving at once, and picks up again if the file comes back", async () => {
      const { companions, saves, emitContent } = backend()
      const { actions, plan, itemStore } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      emitContent(gone)
      await settle()
      expect(itemStore.store.getSnapshot().content[planItem.id]).toEqual(gone)
      await vi.advanceTimersByTimeAsync(5000)
      expect(saves).toHaveLength(0)
      expect(plan().text).toBe(`${first}No blog.\n`)

      emitContent(contentOf(snapshot(first, "1")))
      await settle()
      expect(saves).toHaveLength(1)
      expect(saves[0]!.text).toBe(`${first}No blog.\n`)
    })

    it("tries once more when the person asks, and goes on saying why if it's still gone", async () => {
      const { companions, saves, emitContent } = backend()
      const { actions, plan } = connected(companions)
      actions.edit(`${first}No blog.\n`, [])
      emitContent(gone)
      await settle()
      actions.retry()
      expect(saves).toHaveLength(1)
      saves[0]!.refuse("gone")
      await settle()
      expect(plan().blocked).toBe("gone")
      // The file is back: the stored reason is dropped with the first version that follows.
      emitContent(contentOf(snapshot(first, "1")))
      await settle()
      expect(plan().blocked).toBeNull()
    })
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
    const { itemStore } = connected(companions)
    expect(follows).toEqual([{ id: planItem.id, reveal: undefined }])
    const release = itemStore.watch(target, hero.id)
    const again = itemStore.watch(target, hero.id)
    expect(follows.map((each) => each.id)).toEqual([planItem.id, hero.id])
    expect(itemStore.store.getSnapshot().content[hero.id]).toMatchObject({ reason: "secret" })
    release()
    again()
    expect(stopped).toEqual([])
    // What it held goes a while after the last place showing it.
    vi.advanceTimersByTime(30_000)
    expect(stopped).toEqual([hero.id])
    expect(itemStore.store.getSnapshot().content).not.toHaveProperty(hero.id)
  })

  it("keeps what it held when something shows it again soon, without loading it again", () => {
    const { companions, follows, stopped } = backend()
    const { itemStore } = connected(companions)
    itemStore.watch(target, hero.id)()
    vi.advanceTimersByTime(29_000)
    const release = itemStore.watch(target, hero.id)
    vi.advanceTimersByTime(30_000)
    expect(follows.filter((each) => each.id === hero.id)).toHaveLength(1)
    expect(stopped).toEqual([])
    expect(itemStore.store.getSnapshot().content[hero.id]).toMatchObject({ reason: "secret" })
    release()
    vi.advanceTimersByTime(30_000)
    expect(stopped).toEqual([hero.id])
  })

  it("lets go of what's revealed while shown, once nothing shows it", () => {
    const { companions, follows, stopped } = backend()
    const { itemStore } = connected(companions)
    const release = itemStore.watch(target, hero.id)
    itemStore.reveal(hero.id, "/p/hero.png")
    expect(follows.at(-1)).toEqual({ id: hero.id, reveal: "/p/hero.png" })
    release()
    vi.advanceTimersByTime(30_000)
    expect(stopped).toEqual([hero.id, hero.id])
    expect(itemStore.store.getSnapshot().content).not.toHaveProperty(hero.id)
  })

  it("ignores what it held before it was revealed, should that come late", () => {
    const { companions, listeners } = backend()
    const { itemStore } = connected(companions)
    itemStore.watch(target, hero.id)
    const unrevealed = listeners.get(hero.id)!
    itemStore.reveal(hero.id, "/p/hero.png")
    listeners.get(hero.id)!({ state: "unavailable", reason: "missing", size: null })
    unrevealed({ state: "unavailable", reason: "secret", size: null })
    expect(itemStore.store.getSnapshot().content[hero.id]).toMatchObject({ reason: "missing" })
  })

  it("lets go of what's revealed while nothing shows it", () => {
    const { companions, stopped } = backend()
    const { itemStore } = connected(companions)
    itemStore.watch(target, hero.id)()
    itemStore.reveal(hero.id, "/p/hero.png")
    vi.advanceTimersByTime(30_000)
    expect(stopped).toEqual([hero.id, hero.id])
    expect(itemStore.store.getSnapshot().content).not.toHaveProperty(hero.id)
  })

  it("follows again, revealed, once the person asks to see what may hold secrets", () => {
    const { companions, follows } = backend()
    const { itemStore } = connected(companions)
    itemStore.watch(target, hero.id)
    itemStore.reveal(hero.id, "/p/hero.png")
    expect(follows.at(-1)).toEqual({ id: hero.id, reveal: "/p/hero.png" })
    expect(itemStore.store.getSnapshot().revealed).toEqual({ [hero.id]: pointedHero })
  })

  context("when an item is pointed at another file", () => {
    const held = (name: string) => ({
      ...hero,
      kind: "file" as const,
      name,
      path: `/p/${name}`,
      held: true,
    })
    const repoint = (workspace: WorkspaceStore, name: string) =>
      workspace.dispatch({
        type: "item/upsert",
        target,
        item: { ...held(name), version: workspace.getSnapshot().projects.length + 1 },
      })

    it("shows the gate again for a revealed held file re-pointed to another held one", () => {
      const { companions, follows, listeners } = backend()
      const workspace = workspaceWith()
      const { itemStore } = connected(companions, workspace)
      workspace.dispatch({ type: "item/upsert", target, item: held(".env") })
      itemStore.watch(target, hero.id)
      itemStore.reveal(hero.id, "/p/.env")
      listeners.get(hero.id)!({ state: "unavailable", reason: "missing", size: null })
      expect(follows.at(-1)).toEqual({ id: hero.id, reveal: "/p/.env" })
      repoint(workspace, ".env.local")
      expect(follows.at(-1)).toEqual({ id: hero.id, reveal: undefined })
      expect(itemStore.store.getSnapshot().revealed).toEqual({})
      expect(itemStore.store.getSnapshot().content[hero.id]).toMatchObject({ reason: "secret" })
    })

    it("does not carry a reveal to another file once nothing showed the item meanwhile", () => {
      const { companions, follows } = backend()
      const workspace = workspaceWith()
      const { itemStore } = connected(companions, workspace)
      workspace.dispatch({ type: "item/upsert", target, item: held(".env") })
      const unwatch = itemStore.watch(target, hero.id)
      itemStore.reveal(hero.id, "/p/.env")
      unwatch()
      vi.advanceTimersByTime(31_000)
      repoint(workspace, "secrets.json")
      itemStore.watch(target, hero.id)
      expect(follows.at(-1)).toEqual({ id: hero.id, reveal: undefined })
    })

    it("keeps a reveal for the same file shown again after the linger", () => {
      const { companions, follows } = backend()
      const workspace = workspaceWith()
      const { itemStore } = connected(companions, workspace)
      workspace.dispatch({ type: "item/upsert", target, item: held(".env") })
      const unwatch = itemStore.watch(target, hero.id)
      itemStore.reveal(hero.id, "/p/.env")
      unwatch()
      vi.advanceTimersByTime(31_000)
      itemStore.watch(target, hero.id)
      expect(follows.at(-1)).toEqual({ id: hero.id, reveal: "/p/.env" })
    })

    it("asks for the file the person chose, not the one the window was pointed at since", () => {
      // A backend as the runner is: a stream reveals only while the item is at the path asked.
      const runner = { at: "/p/.env" }
      const asked: (string | undefined)[] = []
      const follow: Companions["follow"] = (_target, _id, { reveal }, on) => {
        asked.push(reveal)
        on(
          reveal === runner.at
            ? { state: "unavailable", reason: "missing", size: null }
            : { state: "unavailable", reason: "secret", size: null },
        )
        return () => {}
      }
      const companions: Companions = {
        ...backend().companions,
        follow,
      }
      const workspace = workspaceWith()
      const { itemStore } = connected(companions, workspace)
      workspace.dispatch({ type: "item/upsert", target, item: held(".env") })
      itemStore.watch(target, hero.id)
      // The person's click on .env races an open the window hasn't heard of yet.
      runner.at = "/p/secrets.json"
      itemStore.reveal(hero.id, "/p/.env")
      expect(asked.at(-1)).toBe("/p/.env")
      expect(itemStore.store.getSnapshot().content[hero.id]).toMatchObject({ reason: "secret" })
    })

    it("ignores a reveal of the file the window showed before it was re-pointed", () => {
      const { companions, follows } = backend()
      const workspace = workspaceWith()
      const { itemStore } = connected(companions, workspace)
      workspace.dispatch({ type: "item/upsert", target, item: held(".env") })
      itemStore.watch(target, hero.id)
      repoint(workspace, "secrets.json")
      // The click on .env's gate came after the window was pointed at secrets.json.
      itemStore.reveal(hero.id, "/p/.env")
      expect(follows.at(-1)).toEqual({ id: hero.id, reveal: undefined })
      expect(itemStore.store.getSnapshot().revealed).toEqual({})
    })

    it("holds the new file's content, not the old one's, and ignores a late report of it", () => {
      const { companions, listeners, stopped } = backend()
      const workspace = workspaceWith()
      const { itemStore } = connected(companions, workspace)
      itemStore.watch(target, hero.id)
      const old = listeners.get(hero.id)!
      const text = (path: string): ItemContent => ({
        state: "ready",
        stamp: path,
        content: {
          kind: "file",
          path,
          firstLine: 1,
          lines: [path],
          from: 1,
          to: 1,
          total: 1,
          truncated: false,
          clamped: false,
        },
      })
      old(text("/p/hero.png"))
      repoint(workspace, "a.ts")
      expect(stopped).toEqual([hero.id])
      old(text("/p/hero.png"))
      listeners.get(hero.id)!(text("/p/a.ts"))
      expect(itemStore.store.getSnapshot().content[hero.id]).toMatchObject({ stamp: "/p/a.ts" })
    })

    // A revealed, followed hero shown as `shown`, and shown again with `again`.
    const shownThenAgain = (shown: Partial<Item>, again: Partial<Item>) => {
      const { companions, follows, stopped, listeners } = backend()
      const workspace = workspaceWith()
      const { itemStore } = connected(companions, workspace)
      workspace.dispatch({ type: "item/upsert", target, item: { ...hero, ...shown } })
      itemStore.watch(target, hero.id)
      itemStore.reveal(hero.id, { ...hero, ...shown }.path ?? null)
      const content: ItemContent = { state: "unavailable", reason: "missing", size: null }
      listeners.get(hero.id)!(content)
      follows.length = 0
      stopped.length = 0
      workspace.dispatch({
        type: "item/upsert",
        target,
        item: { ...hero, ...shown, ...again, version: 2 },
      })
      return { follows, stopped, content, stored: () => itemStore.store.getSnapshot() }
    }

    it("keeps its content and the reveal when only the lines change", () => {
      const file = { kind: "file" as const, name: "a.ts", path: "/p/a.ts" }
      const { follows, stopped, content, stored } = shownThenAgain(file, {
        lines: { from: 3, to: 9 },
      })
      expect(stopped).toEqual([])
      expect(follows).toEqual([])
      expect(stored().content[hero.id]).toEqual(content)
      expect(stored().revealed[hero.id]).toBeDefined()
    })

    it("keeps its content and the reveal when a page is shown at another address", () => {
      const page = {
        kind: "page" as const,
        name: "dev",
        path: null,
        url: "http://localhost:3000/",
      }
      const { follows, stopped, content, stored } = shownThenAgain(page, {
        url: "http://localhost:3000/docs",
      })
      expect(stopped).toEqual([])
      expect(follows).toEqual([])
      expect(stored().content[hero.id]).toEqual(content)
      expect(stored().revealed[hero.id]).toBeDefined()
    })

    it("follows on when the same file is shown again", () => {
      const { companions, follows } = backend()
      const workspace = workspaceWith()
      const { itemStore } = connected(companions, workspace)
      itemStore.watch(target, hero.id)
      itemStore.reveal(hero.id, "/p/hero.png")
      workspace.dispatch({ type: "item/upsert", target, item: { ...hero, version: 2 } })
      expect(follows).toEqual([
        { id: planItem.id, reveal: undefined },
        { id: hero.id, reveal: undefined },
        { id: hero.id, reveal: "/p/hero.png" },
      ])
    })
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
    const { itemStore, workspace } = connected(companions)
    workspace.dispatch({ type: "item/close", target, itemId: planItem.id })
    expect(stopped).toEqual([planItem.id])
    expect(itemStore.store.getSnapshot().plans).toEqual({})
  })
})
