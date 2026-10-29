import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool, type Call } from "./model/script.js"
import { own, result, start, through } from "./scenarios.js"

// An agent's look at a page it showed (docs/agent-messaging.md, "Looking at a page"): the
// deck answers the look as a pane would, and the next thing the harness sends its model
// holds the picture. The same for every harness (see messaging.e2e.ts for the rule on
// parity). The model here is a script, so this checks that each harness passes the image
// of an MCP result on to its model, not what a real model makes of it.

// A 64×48 red JPEG.
const picture =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACBAQExATFhYWFhYWGhgaGxsbGhoaGhsbGx0dHSIiIh0dHRsbHR0gICIiJSYlIyMiIyYmKCgoMDAuLjg4OkVFU//EAE0AAQEAAAAAAAAAAAAAAAAAAAAGAQEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAwAEADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLASbfwAAAAAAAAAAAAAAAAAAAAAH/2Q=="

const url = "http://localhost:5173/"

/** The model's turn: it shows the page, then looks at it, then says what the look gave. */
const rules = (calls: Call[]) => [
  own((call) => {
    const show = tool(call, "show")
    return show && asked(call, "Show and look")
      ? { calls: [{ name: show, input: { page: { url } } }] }
      : undefined
  }),
  own((call) => {
    const look = tool(call, "look")
    const last = call.turns.at(-1)
    if (
      !look ||
      last?.role !== "tool" ||
      !last.text.includes("localhost:5173") ||
      last.text.includes("Looked at the page")
    )
      return undefined
    return { calls: [{ name: look, input: { page: { url } } }] }
  }),
  own((call) => {
    const last = call.turns.at(-1)
    if (last?.role !== "tool" || !last.text.includes("Looked at the page")) return undefined
    calls.push(call)
    return { text: "Saw the page." }
  }),
]

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("hands the picture of a look to the model", async ({ e2e: run }) => {
      const looks = run.deck.answerLooks(picture)
      const seen: Call[] = []
      run.model.use(...rules(seen))
      const t1 = await start(run, setup)
      const mark = t1.mark()

      await t1.submit("Show and look at the page")
      await t1.until("Saw the page.")
      await through(t1, ["settled"], { after: mark })

      expect(looks).toEqual([
        { lookId: expect.any(String), itemId: expect.any(String), shown: 1, url },
      ])
      const last = seen.at(-1)?.turns.at(-1)
      expect(last?.role === "tool" ? last.text : "").toContain('Its title is "Deck page".')
      // The picture itself reached the model, not only words about it.
      expect(last?.role === "tool" ? (last.images ?? 0) : 0).toBeGreaterThan(0)
      expect(result(seen.at(-1)!)).toContain("Looked at the page")
    })
  })
}
