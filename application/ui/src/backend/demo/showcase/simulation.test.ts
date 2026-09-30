import type { CompanionEvent, CompanionKey } from "../../../model/companion"
import { context, describe, expect, it } from "../../../test"
import { authAgent, studioAgent } from "./agents"
import { createShowcase } from "./simulation"

const studio: CompanionKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }
const auth: CompanionKey = { ...studio, terminalId: "03" }
const note = "<!-- novadeck: Keep the serif. -->"

// The agents act at once instead of after their thinking delays.
const running = () => {
  const showcase = createShowcase(
    [
      { key: studio, sample: studioAgent },
      { key: auth, sample: authAgent },
    ],
    (_delay, run) => run(),
  )
  const events: CompanionEvent[] = []
  showcase.subscribe((event) => events.push(event))
  const plan = (key: CompanionKey) =>
    showcase.snapshot().find((companion) => companion.key.terminalId === key.terminalId)!.plans[0]!
  return { showcase, events, plan }
}

describe("showcase agents", () => {
  it("start from their first plan and what they had already shown", () => {
    const { showcase, plan } = running()
    expect(plan(studio)).toMatchObject({ ref: "root", role: "root", text: studioAgent.text })
    expect(showcase.snapshot()[0]!.shown.map((artifact) => artifact.id)).toEqual(["hero", "about"])
  })

  it("keep a terminal's agent to its own session", () => {
    const { showcase, events } = running()
    showcase.told({ ...studio, workspaceSessionId: "other" }, "show")
    expect(events).toEqual([])
  })

  context("when told to show something", () => {
    it("shows the next thing each time, opening it when asked to, until there's nothing left", async () => {
      const { showcase, events } = running()
      for (const input of ["show", "open", "show", "show"]) showcase.told(studio, input)
      expect(events).toMatchObject([
        { type: "artifact/shown", artifact: { id: "home" }, asked: false },
        { type: "artifact/shown", artifact: { id: "preview" }, asked: true },
        { type: "artifact/shown", artifact: { id: "mobile" }, asked: false },
      ])
      expect(await showcase.load(studio, "home")).toMatchObject({ kind: "file", from: 12 })
    })
  })

  context("when the user saves an edit", () => {
    it("writes it over the revision it was made on, and refuses it over a later one", async () => {
      const { showcase, plan } = running()
      const first = plan(studio)
      const edited = `${first.text}No blog.\n`
      expect(await showcase.save(studio, "root", edited, first.revision)).toEqual({
        saved: true,
        revision: "2",
      })
      expect(await showcase.save(studio, "root", "stale", first.revision)).toMatchObject({
        saved: false,
        current: { text: edited, revision: "2" },
      })
    })
  })

  context("when its plan is answered", () => {
    it("revises over the file as the user left it, applying the notes, with the skill", async () => {
      const { showcase, events, plan } = running()
      const saved = `${studioAgent.text}${note}\nNo blog.\n`
      await showcase.save(studio, "root", saved, plan(studio).revision)
      showcase.told(studio, "use a grotesk")
      const [revised] = events
      expect(revised).toMatchObject({ type: "plan/changed", plan: { revision: "3" } })
      const text = revised?.type === "plan/changed" ? revised.plan.text : ""
      expect(text).toContain("confident grotesk")
      expect(text).toContain("No blog.")
      expect(text).not.toContain(note)
    })

    it("re-reads notes before starting once approved, with the skill, and only applies them", async () => {
      const { showcase, events, plan } = running()
      await showcase.save(studio, "root", `${studioAgent.text}${note}\n`, plan(studio).revision)
      showcase.told(studio, "y")
      const [revised] = events
      expect(revised?.type === "plan/changed" && revised.plan.text).toBe(studioAgent.text)
    })

    it("starts without writing again when there's nothing to apply", () => {
      const { showcase, events } = running()
      showcase.told(studio, "y")
      expect(events).toEqual([])
    })
  })

  context("without the skill", () => {
    it("leaves notes alone until asked to re-read the plan", async () => {
      const { showcase, events, plan } = running()
      await showcase.save(auth, "root", authAgent.text + note, plan(auth).revision)
      showcase.told(auth, "y")
      expect(events).toEqual([])
      showcase.told(auth, "please re-read the plan")
      const [revised] = events
      const text = revised?.type === "plan/changed" ? revised.plan.text : ""
      expect(text).not.toContain(note)
      expect(text).toContain("Admin routes will keep a shorter window")
    })
  })

  it("closes a terminal's companion when the terminal closes", () => {
    const { showcase, events } = running()
    showcase.closed(studio)
    expect(events).toEqual([{ type: "companion/closed", key: studio }])
    expect(showcase.snapshot().map((companion) => companion.key.terminalId)).toEqual(["03"])
  })
})
