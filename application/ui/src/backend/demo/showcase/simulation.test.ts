import type { CompanionEvent } from "../../../model/companion"
import { context, describe, expect, it } from "../../../test"
import { authAgent, studioAgent } from "./agents"
import { createShowcase } from "./simulation"

// The agents act at once instead of after their thinking delays.
const running = () => {
  const showcase = createShowcase({ studio: studioAgent, auth: authAgent }, (_delay, run) => run())
  const events: CompanionEvent[] = []
  showcase.subscribe((event) => events.push(event))
  return { showcase, events }
}

const note = "<!-- novadeck: Keep the serif. -->"

describe("showcase agents", () => {
  it("start from their first plan and what they had already shown", () => {
    const { showcase } = running()
    expect(showcase.terminals["studio"]!.plan.text).toBe(studioAgent.revisions[0])
    expect(showcase.terminals["studio"]!.shown.map((artifact) => artifact.id)).toEqual([
      "hero",
      "about",
    ])
  })

  context("when told to show something", () => {
    it("shows the next thing each time, and opens it when asked to, until there's nothing left", () => {
      const { showcase, events } = running()
      for (const input of ["show", "open", "show", "show"]) showcase.told("studio", input)
      expect(events).toMatchObject([
        { type: "artifact/shown", artifact: { id: "home" }, asked: false },
        { type: "artifact/shown", artifact: { id: "preview" }, asked: true },
        { type: "artifact/shown", artifact: { id: "mobile" }, asked: false },
      ])
    })
  })

  context("when its plan is answered", () => {
    it("revises on feedback, reading the notes when it has the skill", () => {
      const { showcase, events } = running()
      showcase.told("studio", "use a grotesk")
      expect(events).toEqual([
        {
          type: "plan/revised",
          terminalId: "studio",
          text: studioAgent.revisions[1],
          appliedNotes: true,
        },
      ])
    })

    it("re-reads notes before starting once approved, with the skill", () => {
      const { showcase, events } = running()
      showcase.save("studio", studioAgent.revisions[0] + note)
      showcase.told("studio", "y")
      expect(events).toMatchObject([{ type: "plan/revised", appliedNotes: true }])
    })

    it("starts without writing again when there's nothing to apply", () => {
      const { showcase, events } = running()
      showcase.told("studio", "y")
      expect(events).toEqual([])
    })
  })

  context("without the skill", () => {
    it("leaves notes alone until asked to re-read the plan", () => {
      const { showcase, events } = running()
      showcase.save("auth", authAgent.revisions[0] + note)
      showcase.told("auth", "y")
      expect(events).toEqual([])
      showcase.told("auth", "please re-read the plan")
      expect(events).toMatchObject([{ type: "plan/revised", appliedNotes: true }])
    })
  })
})
