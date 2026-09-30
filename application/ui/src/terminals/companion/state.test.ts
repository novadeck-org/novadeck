import { afterEach, beforeEach, vi } from "vitest"

import type {
  ArtifactContent,
  CompanionEvent,
  CompanionKey,
  Companions,
  PlanSaved,
  PlanSnapshot,
} from "../../model/companion"
import { context, describe, expect, it } from "../../test"
import { planTab } from "./pane"
import { companionActions, openTab, type CompanionActions } from "./state"

const key: CompanionKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
const first = "# Plan\n\nalpha\nbeta\ngamma\n"

const snapshot = (text: string, revision: string): PlanSnapshot => ({
  ref: "root",
  role: "root",
  path: "plan.md",
  agent: "Codex",
  skill: true,
  text,
  revision,
})

// A backend the test drives: it answers saves when told to, and reports what it's given.
const backend = (shown: CompanionEvent[] = []) => {
  let emit: ((event: CompanionEvent) => void) | undefined
  const saves: {
    readonly text: string
    readonly basedOn: string
    readonly answer: (result: PlanSaved) => void
    readonly fail: () => void
  }[] = []
  let loads = 0
  const companions: Companions = {
    snapshot: () => [{ key, plans: [snapshot(first, "1")], shown: [] }],
    subscribe: (listener) => {
      emit = listener
      for (const event of shown) listener(event)
      return () => {}
    },
    load: () => {
      loads += 1
      return loads === 1
        ? Promise.reject(new Error("offline"))
        : Promise.resolve<ArtifactContent>({ kind: "image", src: "data:," })
    },
    save: (_key, _ref, text, basedOn) =>
      new Promise((resolve, reject) =>
        saves.push({ text, basedOn, answer: resolve, fail: () => reject(new Error("down")) }),
      ),
  }
  return {
    companions,
    saves,
    emit: (event: CompanionEvent) => emit?.(event),
    get loads() {
      return loads
    },
  }
}

// Lets pending answers, and the merge code's lazy import, finish.
const settle = async () => {
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
}

const plan = (actions: CompanionActions) => actions.current().plans[0]!

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
      const actions = companionActions(companions, key)
      const edited = first.replace("beta\n", "beta\nUSER LINE\n")
      actions.edit("root", edited, [])
      actions.flush("root")
      expect(saves).toHaveLength(1)
      // The agent wrote over the saved text before the save's answer came back.
      emit({
        type: "plan/changed",
        key,
        plan: snapshot(edited.replace("gamma", "GAMMA (agent)"), "3"),
      })
      await settle()
      saves[0]!.answer({ saved: true, revision: "2" })
      await settle()
      expect(plan(actions).text).toBe("# Plan\n\nalpha\nbeta\nUSER LINE\nGAMMA (agent)\n")
      expect(plan(actions)).toMatchObject({ revision: "3", writes: 1 })
      expect(saves).toHaveLength(1)
    })

    it("takes the save coming back as the user's own, not a rewrite", async () => {
      const { companions, saves, emit } = backend()
      const actions = companionActions(companions, key)
      const edited = `${first}No blog.\n`
      actions.edit("root", edited, [])
      actions.flush("root")
      emit({ type: "plan/changed", key, plan: snapshot(edited, "2") })
      await settle()
      saves[0]!.answer({ saved: true, revision: "2" })
      await settle()
      expect(plan(actions)).toMatchObject({ text: edited, base: edited, writes: 0 })
    })
  })

  it("applies a rewrite that kept the revision name but changed the text", async () => {
    const { companions, emit } = backend()
    const actions = companionActions(companions, key)
    emit({ type: "plan/changed", key, plan: snapshot(first.replace("alpha", "ALPHA"), "1") })
    await settle()
    expect(plan(actions).text).toContain("ALPHA")
  })

  it("merges a refused save into the file as it stands, and saves the rest again", async () => {
    const { companions, saves } = backend()
    const actions = companionActions(companions, key)
    actions.edit("root", `${first}No blog.\n`, [])
    actions.flush("root")
    saves[0]!.answer({ saved: false, current: snapshot(first.replace("alpha", "ALPHA"), "5") })
    await settle()
    expect(plan(actions).text).toBe("# Plan\n\nALPHA\nbeta\ngamma\nNo blog.\n")
    expect(saves[1]).toMatchObject({
      basedOn: "5",
      text: "# Plan\n\nALPHA\nbeta\ngamma\nNo blog.\n",
    })
  })

  it("tries a failed save again, less often each time, and says the plan isn't saved", async () => {
    const { companions, saves } = backend()
    const actions = companionActions(companions, key)
    actions.edit("root", `${first}No blog.\n`, [])
    actions.flush("root")
    saves[0]!.fail()
    await settle()
    expect(plan(actions).unsaved).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves).toHaveLength(2)
    saves[1]!.answer({ saved: true, revision: "2" })
    await settle()
    expect(plan(actions)).toMatchObject({ unsaved: false, revision: "2" })
  })

  it("stops saying a plan isn't saved once there's nothing left to save", async () => {
    const { companions, saves } = backend()
    const actions = companionActions(companions, key)
    actions.edit("root", `${first}No blog.\n`, [])
    actions.flush("root")
    saves[0]!.fail()
    await settle()
    expect(plan(actions).unsaved).toBe(true)
    actions.edit("root", first, [])
    actions.flush("root")
    expect(plan(actions).unsaved).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(saves).toHaveLength(1)
  })

  it("counts a save that never answers as failed, and ignores its late answer", async () => {
    const { companions, saves } = backend()
    const actions = companionActions(companions, key)
    actions.edit("root", `${first}No blog.\n`, [])
    actions.flush("root")
    await vi.advanceTimersByTimeAsync(20_000)
    expect(plan(actions).unsaved).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves).toHaveLength(2)
    saves[0]!.answer({ saved: true, revision: "late" })
    saves[1]!.answer({ saved: true, revision: "2" })
    await settle()
    expect(plan(actions)).toMatchObject({ unsaved: false, revision: "2" })
  })

  context("when a save timed out but was written", () => {
    it("merges a rewrite over it, so the user's edit stays once", async () => {
      const { companions, saves, emit } = backend()
      const actions = companionActions(companions, key)
      const edited = first.replace("beta\n", "beta\nUSER LINE\n")
      actions.edit("root", edited, [])
      actions.flush("root")
      emit({
        type: "plan/changed",
        key,
        plan: snapshot(edited.replace("gamma", "GAMMA (agent)"), "3"),
      })
      await vi.advanceTimersByTimeAsync(20_000)
      await settle()
      expect(plan(actions).text).toBe("# Plan\n\nalpha\nbeta\nUSER LINE\nGAMMA (agent)\n")
      saves[0]!.answer({ saved: true, revision: "2" })
      await settle()
      expect(plan(actions).text.split("USER LINE")).toHaveLength(2)
    })

    it("keeps the user's edit when the save never reached the file", async () => {
      const { companions, saves, emit } = backend()
      const actions = companionActions(companions, key)
      actions.edit("root", first.replace("beta\n", "beta\nUSER LINE\n"), [])
      actions.flush("root")
      saves[0]!.fail()
      await settle()
      emit({ type: "plan/changed", key, plan: snapshot(first.replace("gamma", "GAMMA"), "3") })
      await settle()
      expect(plan(actions).text).toBe("# Plan\n\nalpha\nbeta\nUSER LINE\nGAMMA\n")
    })

    it("takes the file refusing a retry with that save's text as the user's own", async () => {
      const { companions, saves } = backend()
      const actions = companionActions(companions, key)
      actions.edit("root", `${first}ONE\n`, [])
      actions.flush("root")
      await vi.advanceTimersByTimeAsync(20_000)
      actions.edit("root", `${first}ONE\nTWO\n`, [])
      await vi.advanceTimersByTimeAsync(2000)
      saves[1]!.answer({ saved: false, current: snapshot(`${first}ONE\n`, "2") })
      await settle()
      expect(plan(actions)).toMatchObject({ text: `${first}ONE\nTWO\n`, writes: 0, revision: "2" })
      expect(saves[2]).toMatchObject({ basedOn: "2", text: `${first}ONE\nTWO\n` })
    })
  })

  it("saves once typing pauses", async () => {
    const { companions, saves } = backend()
    const actions = companionActions(companions, key)
    actions.edit("root", `${first}N`, [])
    actions.edit("root", `${first}No`, [])
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(saves.map((save) => save.text)).toEqual([`${first}No`])
  })

  it("closes a pane left with nothing to show, so nothing reopens it later", async () => {
    const { companions, emit } = backend()
    const actions = companionActions(companions, key)
    actions.update((pane) => openTab(pane, planTab("root")))
    emit({ type: "plan/removed", key, ref: "root" })
    expect(actions.current().open).toBe(false)
    emit({
      type: "plan/changed",
      key,
      plan: { ...snapshot("# Later\n", "9"), ref: "sub", role: "subagent" },
    })
    await settle()
    expect(actions.current()).toMatchObject({ open: false, plans: [{ ref: "sub" }] })
  })

  it("keeps the file's line breaks when saving", async () => {
    const crlf = first.replaceAll("\n", "\r\n")
    const { companions, saves, emit } = backend()
    const actions = companionActions(companions, key)
    emit({ type: "plan/changed", key, plan: snapshot(crlf, "2") })
    await settle()
    actions.edit("root", `${plan(actions).text}No blog.\n`, [])
    actions.flush("root")
    expect(saves[0]!.text).toBe(`${crlf}No blog.\r\n`)
  })

  it("loads an artifact again after a load failed", async () => {
    const { companions, emit } = backend()
    const actions = companionActions(companions, key)
    const artifact = {
      id: "hero",
      kind: "image",
      name: "hero.png",
      detail: "",
      version: 1,
    } as const
    emit({ type: "artifact/shown", key, artifact, asked: false })
    const shown = actions.current().artifacts[0]!
    await expect(actions.load(shown)).rejects.toThrow()
    await expect(actions.load(shown)).resolves.toMatchObject({ kind: "image" })
  })
})
