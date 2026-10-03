import {
  itemIdOf,
  type CompanionItem,
  type CompanionKey,
  type ItemContent,
} from "../../../model/companion"
import { context, describe, expect, it } from "../../../test"
import type { BackendAction } from "../../port"
import { authAgent, studioAgent } from "./agents"
import { devServerArtifacts, studioArtifacts } from "./artifacts"
import { createShowcase } from "./simulation"

const session = { projectId: "p", workspaceSessionId: "s" }
const studio: CompanionKey = { ...session, terminalId: "01" }
const auth: CompanionKey = { ...session, terminalId: "03" }
const devServer: CompanionKey = { ...session, terminalId: "02" }
const note = "<!-- novadeck: Keep the serif. -->"
const studioPlan = itemIdOf(studioAgent.plan.id)
const authPlan = itemIdOf(authAgent.plan.id)

// The agents act at once instead of after their thinking delays, and report to a session
// that keeps what they report.
const running = (
  agents = [
    { key: studio, handle: "t1", sample: studioAgent },
    { key: auth, handle: "t3", sample: authAgent },
  ],
) => {
  const showcase = createShowcase(
    { agents, shown: [{ key: devServer, handle: "t2", artifacts: devServerArtifacts }] },
    (_delay, run) => run(),
    () => 100,
  )
  let items: readonly CompanionItem[] = showcase.items
  const reported: BackendAction[] = []
  const report = (actions: readonly BackendAction[]) => {
    reported.push(...actions)
    for (const action of actions)
      if (action.type === "item/upsert")
        items = [...items.filter((item) => item.id !== action.item.id), action.item]
  }
  const stop = showcase.start(report, () => items)
  // What the agents reported as the demo started, apart from what follows.
  const started = reported.splice(0)
  // What a plan holds now, as following it says.
  const contentOf = (id: CompanionItem["id"], reveal = false) => {
    let content: ItemContent | undefined
    showcase.follow(session, id, { reveal }, (next) => (content = next))()
    return content
  }
  const planText = (id: CompanionItem["id"]) => {
    const content = contentOf(id)
    return content?.state === "ready" && content.content.kind === "plan" ? content.content.text : ""
  }
  // The stamp a plan stands at, which an edit is made on.
  const stampOf = (id: CompanionItem["id"]) => {
    const content = contentOf(id)
    return content?.state === "ready" ? content.stamp : ""
  }
  // The person moved an item somewhere else, as undocking does.
  const hold = (id: string, holder: CompanionItem["holder"]) =>
    void (items = items.map((item) => (item.id === id ? { ...item, holder } : item)))
  return { showcase, reported, started, stop, contentOf, planText, stampOf, hold }
}

describe("showcase agents", () => {
  it("start from their first plan and what they had already shown", () => {
    const { showcase } = running()
    const studioItems = showcase.items.filter(
      (item) => "terminalId" in item.holder && item.holder.terminalId === "01",
    )
    expect(studioItems.map((item) => item.id)).toEqual([
      "studio-plan",
      "studio-hero",
      "studio-about",
      "studio-voice",
    ])
    expect(studioItems[0]).toMatchObject({
      kind: "plan",
      name: "A home for Studio",
      from: { terminalId: "01", handle: "t1" },
      plan: { agent: "Codex", role: "root", source: "file" },
    })
  })

  it("write their plans anew and open what they open as the demo starts, once", () => {
    const { showcase, started } = running()
    expect(started).toEqual([
      {
        type: "item/upsert",
        target: studio,
        item: expect.objectContaining({ id: studioPlan, version: 2 }),
      },
      {
        type: "item/upsert",
        target: studio,
        item: expect.objectContaining({ id: "studio-projects", asked: true }),
      },
      {
        type: "item/upsert",
        target: auth,
        item: expect.objectContaining({ id: authPlan, version: 2 }),
      },
    ])
    const later: BackendAction[] = []
    showcase.start(
      (actions) => later.push(...actions),
      () => [],
    )
    expect(later).toEqual([])
  })

  it("serve what each item holds, and why it can't show", () => {
    const { contentOf } = running()
    expect(contentOf(itemIdOf("studio-projects"))).toMatchObject({
      state: "ready",
      content: { kind: "file", path: "src/content/projects.json" },
    })
    expect(contentOf(itemIdOf("dev-notes"))).toEqual({
      state: "unavailable",
      reason: "missing",
      size: null,
    })
    expect(contentOf(itemIdOf("dev-env"))).toMatchObject({ state: "unavailable", reason: "held" })
    expect(contentOf(itemIdOf("dev-env"), true)).toMatchObject({ state: "ready" })
    expect(contentOf(itemIdOf("nothing"))).toMatchObject({ reason: "gone" })
  })

  it("show one of each reason something can't show", () => {
    const reasons = devServerArtifacts.flatMap(({ content }) =>
      content.state === "unavailable" ? [content.reason] : [],
    )
    expect(reasons.toSorted()).toEqual(
      ["binary", "gone", "missing", "not-a-file", "too-large", "unreadable"].toSorted(),
    )
  })

  it("keep a terminal's agent to its own session", () => {
    const { showcase, reported } = running()
    showcase.told({ ...studio, workspaceSessionId: "other" }, "show")
    expect(reported).toEqual([])
  })

  context("when told to show something", () => {
    it("shows the next thing each time, opening it when asked to, until there's nothing left", () => {
      const { showcase, reported } = running()
      for (const input of ["show", "open", "show", "show"]) showcase.told(studio, input)
      expect(reported).toMatchObject([
        { item: { id: "studio-home", asked: false, holder: { terminalId: "01" } } },
        { item: { id: "studio-preview", asked: true } },
        { item: { id: "studio-mobile", asked: false } },
      ])
    })

    it("updates what its own bar already shows of the same file", () => {
      const [projects] = studioArtifacts.opened!
      const sample = {
        ...studioAgent,
        artifacts: { shown: [], opened: [projects!], next: [projects!] },
      }
      const { showcase, reported } = running([{ key: studio, handle: "t1", sample }])
      showcase.told(studio, "show")
      expect(reported).toMatchObject([{ item: { id: "studio-projects", version: 2 } }])
    })
  })

  context("when the person saves an edit", () => {
    it("writes it over the stamp it was made on, and refuses it over a later one", async () => {
      const { showcase, planText, stampOf } = running()
      const stamp = stampOf(studioPlan)
      const edited = `${planText(studioPlan)}No blog.\n`
      expect(await showcase.save(session, studioPlan, edited, stamp)).toEqual({
        saved: true,
        stamp: String(Number(stamp) + 1),
      })
      expect(await showcase.save(session, studioPlan, "stale", stamp)).toMatchObject({
        saved: false,
        current: { plan: { text: edited } },
      })
    })
  })

  context("when its plan is answered", () => {
    it("revises over the file as the person left it, applying the notes, with the skill", async () => {
      const { showcase, reported, planText, stampOf } = running()
      const saved = `${studioAgent.text}${note}\nNo blog.\n`
      await showcase.save(session, studioPlan, saved, stampOf(studioPlan))
      showcase.told(studio, "use a grotesk")
      expect(reported).toMatchObject([
        { type: "item/upsert", item: { id: studioPlan, version: 3 } },
      ])
      const text = planText(studioPlan)
      expect(text).toContain("confident grotesk")
      expect(text).toContain("No blog.")
      expect(text).not.toContain(note)
    })

    it("re-reads notes before starting once approved, with the skill, and only applies them", async () => {
      const { showcase, planText, stampOf } = running()
      await showcase.save(session, studioPlan, `${studioAgent.text}${note}\n`, stampOf(studioPlan))
      showcase.told(studio, "y")
      expect(planText(studioPlan)).toBe(studioAgent.text)
    })

    it("leaves a plan the person undocked where it is, and writes its plan anew on its bar", () => {
      const { showcase, reported, hold, planText } = running()
      hold(studioPlan, { windowId: "w1" })
      showcase.told(studio, "use a grotesk")
      expect(reported).toMatchObject([
        {
          type: "item/upsert",
          item: { id: `${studioPlan}-2`, version: 1, holder: { terminalId: "01" } },
        },
      ])
      // The undocked one still shows the plan as it now stands.
      expect(planText(studioPlan)).toContain("confident grotesk")
    })

    it("starts without writing again when there's nothing to apply", () => {
      const { showcase, reported } = running()
      showcase.told(studio, "y")
      expect(reported).toEqual([])
    })

    it("tells whoever follows the plan of each version", async () => {
      const { showcase, stampOf } = running()
      const seen: string[] = []
      const stop = showcase.follow(session, studioPlan, { reveal: false }, (content) => {
        if (content.state === "ready" && content.content.kind === "plan")
          seen.push(content.content.text)
      })
      await showcase.save(session, studioPlan, "edited\n", stampOf(studioPlan))
      stop()
      await showcase.save(session, studioPlan, "later\n", stampOf(studioPlan))
      expect(seen).toEqual([studioAgent.text, "edited\n"])
    })
  })

  context("without the skill", () => {
    it("leaves notes alone until asked to re-read the plan", async () => {
      const { showcase, reported, planText, stampOf } = running()
      await showcase.save(session, authPlan, authAgent.text + note, stampOf(authPlan))
      showcase.told(auth, "y")
      expect(reported).toEqual([])
      showcase.told(auth, "please re-read the plan")
      const text = planText(authPlan)
      expect(text).not.toContain(note)
      expect(text).toContain("Admin routes will keep a shorter window")
    })
  })

  it("stops answering once its terminal closes", () => {
    const { showcase, reported } = running()
    showcase.closed(studio)
    showcase.told(studio, "show")
    expect(reported).toEqual([])
  })
})
