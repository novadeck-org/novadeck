import { beforeAll, describe, expect, it } from "vitest"

import { build } from "../extract/main.ts"
import type { Atlas } from "../src/atlas.ts"
import { brief, queryOf, subjects } from "./main.ts"

let atlas: Atlas
// A build takes about 2 s alone, but Test (macOS) runs every package's tests at once on a
// small runner: there it took 2-28 s before #660 and up to 31.6 s after, which cut it short
// at 30 s. Two minutes is the most `ensureBuilt` waits for another build's lock as well.
beforeAll(async () => {
  atlas = await build()
}, 120_000)

// A copy of the atlas to change one fact in, so a test doesn't depend on today's source.
const changed = (change: (copy: Atlas) => void): Atlas => {
  const copy = structuredClone(atlas)
  change(copy)
  return copy
}

// Briefs exist to fit in an agent's context: the index stays under 8000 characters and
// every other subject under 6000 (about 1.5k tokens).
describe("brief", () => {
  it("renders every subject within budget", () => {
    expect(brief(atlas, undefined).text.length).toBeLessThan(8000)
    // The overviews are also asked for by their bare names, as AGENTS.md tells people to.
    const bare = ["api", "data", "state", "flows", "harnesses"]
    const asked = [...bare, ...subjects(atlas).map(({ kind, name }) => `${kind}:${name}`)]
    const over = asked
      .map((subject) => ({ subject, ...brief(atlas, subject) }))
      .filter(({ found, text }) => !found || text.length > 6000)
      .map(({ subject, text }) => `${subject}: ${text.length}`)
    expect(over).toEqual([])
  })
})

describe("asking for a subject", () => {
  it("takes a kind prefix, and names the kinds of an ambiguous name", () => {
    const twice = changed((copy) => {
      copy.data.tables[0]!.name = copy.api.procedures[0]!.id
    })
    const name = twice.api.procedures[0]!.id
    const ambiguous = brief(twice, name)
    expect(ambiguous.found).toBe(false)
    expect(ambiguous.text).toContain(`procedure:${name}`)
    expect(ambiguous.text).toContain(`table:${name}`)
    expect(brief(twice, `procedure:${name}`)).toMatchObject({ found: true })
    expect(brief(twice, `procedure:${name}`).text).toMatch(/^# Procedure/)
  })

  it("suggests close names, and the area that owns a path", () => {
    const procedure = atlas.api.procedures.find((p) => p.id === "terminals.create")!
    expect(brief(atlas, "terminals.creat").text).toContain(`procedure:${procedure.id}`)
    const area = atlas.areas.find((a) => a.id === "backend/runner/terminals")!
    for (const path of ["backend/runner/src/terminals", "backend/runner/src/terminals/x.ts"]) {
      const asked = brief(atlas, path)
      expect(asked.found).toBe(false)
      expect(asked.text).toContain(`Close: area:${area.id}`)
    }
    expect(brief(atlas, "no-such-subject-anywhere").text).toContain(
      "Run with no subject for the index",
    )
  })
})

describe("what a brief says", () => {
  it("says when an anchor's line was not found, rather than print a bare file", () => {
    const rotted = changed((copy) => {
      copy.flows[0]!.steps[0]!.anchor = { file: "backend/runner/src/gone.ts", line: null }
    })
    expect(brief(rotted, `flow:${rotted.flows[0]!.id}`).text).toContain(
      "backend/runner/src/gone.ts (anchor not found)",
    )
  })

  it("lists each harness's hooks, which are conditional, and the required members it lacks", () => {
    const lacking = changed((copy) => {
      const required = copy.agents.contract.find((m) => !m.optional)!.name
      copy.agents.harnesses[0]!.implements = copy.agents.harnesses[0]!.implements.filter(
        (name) => name !== required,
      )
      copy.agents.hooks.push({
        ...copy.agents.hooks.find((k) => k.harness === copy.agents.harnesses[0]!.id)!,
        event: "Odd",
        conditional: true,
      })
    })
    const text = brief(lacking, "harnesses").text
    const required = lacking.agents.contract.find((m) => !m.optional)!.name
    expect(text).toContain(`Lacks required: ${required}`)
    expect(text).toContain("Odd (conditional)")
    // Each harness says which hooks it has, the status line among them where it reports one.
    for (const harness of atlas.agents.harnesses)
      for (const hook of atlas.agents.hooks.filter((k) => k.harness === harness.id))
        expect(text).toContain(hook.event)
    expect(
      atlas.agents.hooks.filter((k) => k.event === "StatusLine").map((k) => k.harness),
    ).toEqual(expect.arrayContaining(["claude", "agy"]))
  })

  it("says a procedure reached only on every commit plainly", () => {
    const procedure = atlas.ui.procedures[0]!
    const commitOnly = changed((copy) => {
      copy.ui.procedures[0]!.fromCommit = true
      for (const action of copy.ui.actions)
        for (const effect of action.effects)
          effect.procedures = effect.procedures.filter((id) => id !== procedure.id)
      copy.ui.everyCommit = [{ ...copy.ui.everyCommit[0]!, procedures: [procedure.id] }]
    })
    const text = brief(commitOnly, `procedure:${procedure.id}`).text
    expect(text).toContain("Reached on every store commit (no single action found).")
    expect(text).not.toContain("Reached by UI actions: none")
  })
})

describe("the command line", () => {
  it("takes a kind and a name as two words, past pnpm's `--`, and refuses more", () => {
    expect(queryOf(atlas, [])).toBeUndefined()
    expect(queryOf(atlas, ["--", "terminals.create"])).toBe("terminals.create")
    expect(queryOf(atlas, ["table", "terminals"])).toBe("table:terminals")
    expect(queryOf(atlas, ["terminals.create", "extra"])).toBeInstanceOf(Error)
    expect(brief(atlas, queryOf(atlas, ["terminals.create", "extra"])).found).toBe(false)
    // A path behind a kind still suggests its area.
    expect(brief(atlas, "area:backend/runner/src/terminals").text).toContain(
      "Close: area:backend/runner/terminals",
    )
  })
})

// The handlers the review found pointing at a guard or a callback, as the router has them.
describe("the runner's procedures", () => {
  const procedure = (id: string) => atlas.api.procedures.find((p) => p.id === id)!

  it("point at the call that does their work", () => {
    expect(procedure("companions.save").area).toBe("backend/runner/companions")
    expect(procedure("terminals.upload").handler?.file).toBe(
      "backend/runner/src/terminals/uploads.ts",
    )
    expect(procedure("sessions.create").handler?.file).toBe(
      "backend/runner/src/workspaces/store.ts",
    )
  })

  it("say when the trace doesn't follow the handler", () => {
    const save = procedure("companions.save")
    expect(brief(atlas, "procedure:companions.save").text).toContain(
      `The handler (${save.handler!.file}:${save.handler!.line}) is not traced here`,
    )
    expect(brief(atlas, "procedure:terminals.create").text).not.toContain("is not traced here")
  })
})
