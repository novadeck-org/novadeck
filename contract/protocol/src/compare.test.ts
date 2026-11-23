import { eventIterator, oc } from "@orpc/contract"
import { describe as context, describe, expect, it } from "vitest"
import { z } from "zod"

import { compareContracts, judgeContract, judgeReleases, type Finding } from "./compare.js"
import { compatibility, type Compatibility } from "./compatibility.js"
import { contract } from "./contract.js"
import { inputEnum, inputUnion, openEnum, openUnion } from "./open.js"
import { snapshotContract, type ContractSnapshot } from "./snapshot.js"

const window = (
  revision: number,
  oldestClient = revision,
  oldestRunner = revision,
): Compatibility => ({
  revision,
  oldestClient,
  oldestRunner,
})

const call = oc.errors({ CONFLICT: { status: 409 } })

// A small contract of the shapes the real one has, which each case changes one way.
const base = {
  sessions: {
    save: call
      .input(
        z.strictObject({
          sessionId: z.uuid(),
          state: z.string().max(1024),
          mode: z.enum(["replace", "keep"]),
        }),
      )
      .output(z.void()),
    get: call
      .input(z.strictObject({ sessionId: z.uuid() }))
      .output(z.strictObject({ id: z.uuid(), name: z.string().max(80), rank: z.number().int() })),
    watch: call
      .input(z.void())
      .output(
        eventIterator(
          z.discriminatedUnion("type", [
            z.strictObject({ type: z.literal("changed"), id: z.uuid() }),
            z.strictObject({ type: z.literal("synced") }),
          ]),
        ),
      ),
  },
}

const snap = (shape: object, at: Compatibility = window(2)): ContractSnapshot =>
  snapshotContract(shape as never, at)

const findings = (after: object): readonly Finding[] =>
  compareContracts(snap(base), snap(after, window(3))).findings

const sides = (after: object) => {
  const found = findings(after)
  return {
    ui: found
      .filter((finding) => finding.behind === "ui")
      .map(({ procedure, at }) => `${procedure} ${at}`),
    runner: found
      .filter((finding) => finding.behind === "runner")
      .map(({ procedure, at }) => `${procedure} ${at}`),
  }
}

const withSave = (input: z.ZodType) => ({
  ...base,
  sessions: { ...base.sessions, save: call.input(input).output(z.void()) },
})
const withGet = (output: z.ZodType) => ({
  ...base,
  sessions: {
    ...base.sessions,
    get: call.input(z.strictObject({ sessionId: z.uuid() })).output(output),
  },
})
const saveFields = {
  sessionId: z.uuid(),
  state: z.string().max(1024),
  mode: z.enum(["replace", "keep"]),
}
const getFields = { id: z.uuid(), name: z.string().max(80), rank: z.number().int() }

describe("compareContracts", () => {
  context("over the real contract", () => {
    // As contract.json holds it, which snapshot.test.ts pins.
    it("finds nothing between it and itself", () => {
      const written = snapshotContract(contract, compatibility)
      expect(judgeContract(written, written)).toEqual({ findings: [], gated: [], problems: [] })
    })
  })

  context("with a new optional input field", () => {
    it("leaves no one behind: an older runner drops it", () => {
      const after = withSave(z.strictObject({ ...saveFields, base: z.number().int().optional() }))
      expect(sides(after)).toEqual({ ui: [], runner: [] })
    })
  })

  context("with a new output field", () => {
    it("leaves older runners behind while it's required", () => {
      const after = withGet(z.strictObject({ ...getFields, revision: z.number().int() }))
      expect(sides(after)).toEqual({ ui: [], runner: ["sessions.get output/revision"] })
    })

    it("leaves no one behind when it's optional", () => {
      const after = withGet(z.strictObject({ ...getFields, revision: z.number().int().optional() }))
      expect(sides(after)).toEqual({ ui: [], runner: [] })
    })
  })

  context("with a new procedure", () => {
    const added = {
      ...base,
      sessions: { ...base.sessions, drop: call.input(z.void()).output(z.void()) },
    }

    it("leaves older runners behind without `since`", () => {
      expect(sides(added)).toEqual({ ui: [], runner: ["sessions.drop "] })
    })

    it("is gated, leaving no one behind, when marked since the next revision", () => {
      const gated = {
        ...base,
        sessions: {
          ...base.sessions,
          drop: call.meta({ since: 3 }).input(z.void()).output(z.void()),
        },
      }
      const result = compareContracts(snap(base), snap(gated, window(3)))
      expect(result).toEqual({ findings: [], gated: ["sessions.drop"] })
    })
  })

  context("with a new value in an output", () => {
    it("leaves older UIs behind, naming the variant a stream adds", () => {
      const after = {
        ...base,
        sessions: {
          ...base.sessions,
          watch: call
            .input(z.void())
            .output(
              eventIterator(
                z.discriminatedUnion("type", [
                  z.strictObject({ type: z.literal("changed"), id: z.uuid() }),
                  z.strictObject({ type: z.literal("synced") }),
                  z.strictObject({ type: z.literal("removed"), id: z.uuid() }),
                ]),
              ),
            ),
        },
      }
      expect(findings(after)).toEqual([
        {
          procedure: "sessions.watch",
          behind: "ui",
          at: 'yields/type="removed"',
          reason: 'adds the "removed" variant of "type"',
        },
      ])
    })

    it("leaves older UIs behind for an enum's new value", () => {
      const after = withGet(
        z.strictObject({ ...getFields, rank: z.union([z.number().int(), z.literal("top")]) }),
      )
      expect(sides(after)).toEqual({ ui: ["sessions.get output/rank/1"], runner: [] })
    })
  })

  context("with a new value or a looser bound in an input", () => {
    it("leaves older runners behind for an enum's new value", () => {
      const after = withSave(
        z.strictObject({ ...saveFields, mode: z.enum(["replace", "keep", "merge"]) }),
      )
      expect(sides(after)).toEqual({ ui: [], runner: ["sessions.save input/mode"] })
    })

    it("leaves older runners behind for a longer limit", () => {
      const after = withSave(z.strictObject({ ...saveFields, state: z.string().max(2048) }))
      expect(sides(after)).toEqual({ ui: [], runner: ["sessions.save input/state"] })
    })

    it("leaves older UIs behind for a shorter limit", () => {
      const after = withSave(z.strictObject({ ...saveFields, state: z.string().max(512) }))
      expect(sides(after)).toEqual({ ui: ["sessions.save input/state"], runner: [] })
    })
  })

  context("with a bound changed in an output", () => {
    // The UI never validates what it reads, and its types hold no bounds.
    it("leaves no one behind", () => {
      const after = withGet(z.strictObject({ ...getFields, name: z.string().max(4096) }))
      expect(sides(after)).toEqual({ ui: [], runner: [] })
    })
  })

  context("with something taken away or renamed", () => {
    it("leaves older UIs behind for a removed procedure", () => {
      const { get: _, ...sessions } = base.sessions
      expect(sides({ sessions })).toEqual({ ui: ["sessions.get "], runner: [] })
    })

    it("leaves older UIs behind for a removed output field", () => {
      const { rank: _, ...rest } = getFields
      expect(sides(withGet(z.strictObject(rest)))).toEqual({
        ui: ["sessions.get output/rank"],
        runner: [],
      })
    })

    it("leaves older UIs behind for a new required input field", () => {
      const after = withSave(z.strictObject({ ...saveFields, base: z.number().int() }))
      expect(sides(after)).toEqual({ ui: ["sessions.save input/base"], runner: [] })
    })

    it("leaves both behind for a renamed field", () => {
      const { state, ...rest } = saveFields
      const after = withSave(z.strictObject({ ...rest, layout: state }))
      expect(sides(after)).toEqual({
        ui: ["sessions.save input/layout"],
        runner: ["sessions.save input/state"],
      })
    })
  })

  context("in a union told apart by its keys alone", () => {
    const answers = (...options: z.ZodType[]) => ({
      requests: {
        answer: call.input(z.union(options as [z.ZodType, z.ZodType])).output(z.void()),
      },
    })

    // An older runner can't tell which option failed only on the new key, so drops nothing.
    it("leaves older runners behind for a key added to an option", () => {
      const before = answers(
        z.strictObject({ id: z.uuid() }),
        z.strictObject({ id: z.uuid(), reason: z.string() }),
      )
      const after = answers(
        z.strictObject({ id: z.uuid() }),
        z.strictObject({ id: z.uuid(), reason: z.string(), extra: z.string().optional() }),
      )
      const found = compareContracts(snap(before), snap(after, window(3))).findings.map(
        (finding) => finding.behind,
      )
      expect(found).toContain("runner")
    })

    it("leaves older runners behind for a field another option reads another way", () => {
      const before = answers(
        z.strictObject({ id: z.uuid(), n: z.number() }),
        z.strictObject({ id: z.uuid() }),
      )
      const after = answers(
        z.strictObject({ id: z.uuid(), n: z.string() }),
        z.strictObject({ id: z.uuid() }),
      )
      const found = compareContracts(snap(before), snap(after, window(3))).findings.map(
        (finding) => finding.behind,
      )
      expect(found).toEqual(expect.arrayContaining(["ui", "runner"]))
    })
  })

  context("with error data", () => {
    const withConflict = (data: z.ZodType | undefined) => {
      const errors = oc.errors({ CONFLICT: { status: 409, ...(data && { data }) } })
      return { sessions: { get: errors.input(z.void()).output(z.void()) } }
    }

    it("leaves older runners behind when a code gains data a newer UI needs", () => {
      const result = compareContracts(
        snap(withConflict(undefined)),
        snap(withConflict(z.strictObject({ revision: z.number() })), window(3)),
      )
      expect(result.findings.map((finding) => [finding.procedure, finding.behind])).toEqual([
        ["errors.CONFLICT", "runner"],
      ])
    })

    it("leaves no one behind when the data is optional", () => {
      const result = compareContracts(
        snap(withConflict(undefined)),
        snap(withConflict(z.strictObject({ revision: z.number() }).optional()), window(3)),
      )
      expect(result.findings).toEqual([])
    })
  })

  context("with a keyword zod doesn't write", () => {
    it("reports a break both ways, as it can't tell", () => {
      const before = snap(base)
      const get = before.procedures["sessions.get"]!
      const after: ContractSnapshot = {
        ...before,
        revision: 3,
        procedures: {
          ...before.procedures,
          "sessions.get": { ...get, output: { ...get.output, if: { type: "object" } } },
        },
      }
      const found = compareContracts(before, after).findings.map((finding) => finding.behind)
      expect(found).toEqual(["ui", "runner"])
    })
  })

  context("with a recursive schema", () => {
    const tree = (leaf: z.ZodType) => {
      type Node = { readonly name: string; readonly children: readonly Node[] }
      const node: z.ZodType<Node> = z.lazy(() =>
        z.strictObject({ name: leaf as z.ZodType<string>, children: z.array(node) }),
      )
      return { tree: { get: call.input(z.void()).output(node) } }
    }

    it("ends, finding what changed inside", () => {
      const result = compareContracts(snap(tree(z.string())), snap(tree(z.number()), window(3)))
      expect(result.findings.map((finding) => [finding.behind, finding.at])).toEqual([
        ["ui", "output/name"],
        ["runner", "output/name"],
      ])
    })
  })
})

describe("open schemas", () => {
  const items = (kind: z.ZodType) => ({
    items: { list: call.input(z.void()).output(z.array(z.strictObject({ id: z.uuid(), kind }))) },
  })
  const uiFindings = (before: object, after: object, at: Compatibility) =>
    compareContracts(snap(before, window(3)), snap(after, at)).findings.filter(
      (finding) => finding.behind === "ui",
    )

  it("let a new value pass once every UI in the window reads it tolerantly", () => {
    const before = items(openEnum(["image", "file"], { since: 3, unknown: "placeholder" }))
    const after = items(
      openEnum(["image", "file", "hologram"], { since: 3, unknown: "placeholder" }),
    )
    expect(uiFindings(before, after, window(4, 3, 3))).toEqual([])
  })

  it("leave older UIs behind while the window still takes UIs from before the mark", () => {
    const before = items(openEnum(["image", "file"], { since: 3, unknown: "placeholder" }))
    const after = items(
      openEnum(["image", "file", "hologram"], { since: 3, unknown: "placeholder" }),
    )
    expect(uiFindings(before, after, window(4, 2, 2))).not.toEqual([])
  })

  it("let a new variant pass in an open union", () => {
    const union = (...variants: string[]) =>
      items(
        openUnion(
          "type",
          variants.map((type) => z.strictObject({ type: z.literal(type) })) as never,
          { since: 3, unknown: "placeholder" },
        ),
      )
    expect(
      uiFindings(union("close", "run"), union("close", "run", "hand"), window(4, 3, 3)),
    ).toEqual([])
  })

  // A nullable one is wrapped in a union with null, where the mark sits inside.
  it("let a new value pass in a nullable open enum, and a new variant in a nullable open union", () => {
    const kinds = (...values: [string, ...string[]]) =>
      items(openEnum(values, { since: 3, unknown: "placeholder" }).nullable())
    expect(
      uiFindings(kinds("image", "file"), kinds("image", "file", "hologram"), window(4, 3, 3)),
    ).toEqual([])
    const union = (...variants: string[]) =>
      items(
        openUnion(
          "type",
          variants.map((type) => z.strictObject({ type: z.literal(type) })) as never,
          { since: 3, unknown: "placeholder" },
        ).nullable(),
      )
    expect(
      uiFindings(union("close", "run"), union("close", "run", "hand"), window(4, 3, 3)),
    ).toEqual([])
  })

  it("hold a released mark as it was", () => {
    const before = items(openEnum(["image"], { since: 3, unknown: "placeholder" }))
    const after = items(openEnum(["image"], { since: 2, unknown: "placeholder" }))
    expect(uiFindings(before, after, window(4, 3, 3)).map(({ reason }) => reason)).toContain(
      "changed or lost the open mark a release had",
    )
  })

  it("refuse a new mark that names a revision the release's UIs had", () => {
    const before = items(z.enum(["image"]))
    const after = items(openEnum(["image"], { since: 3, unknown: "placeholder" }))
    expect(uiFindings(before, after, window(4, 3, 3)).map(({ reason }) => reason)).toEqual([
      expect.stringContaining("is marked open since 3"),
      expect.stringContaining('takes "newer"'),
    ])
  })
})

describe("input values marked since", () => {
  // The release is at revision 3; what a newer one adds is gated on the runner's revision.
  const harnesses = (schema: z.ZodType) => ({
    agents: { open: call.input(z.strictObject({ harness: schema })).output(z.void()) },
  })
  const released = harnesses(z.enum(["claude", "codex"]))
  const compare = (after: object, at: Compatibility = window(7, 3, 2)) =>
    judgeContract(snap(released, window(3, 3, 2)), snap(after, at))
  const runner = (after: object, at?: Compatibility) =>
    compare(after, at).findings.filter((finding) => finding.behind === "runner")

  it("pass a marked new value of an input enum, and list it as gated", () => {
    const after = harnesses(inputEnum(["claude", "codex", "opencode"], { since: { opencode: 7 } }))
    const verdict = compare(after)
    expect(verdict.findings).toEqual([])
    expect(verdict.problems).toEqual([])
    expect(verdict.gated).toEqual(['agents.open input/harness "opencode" since 7'])
  })

  it("pass in a nullable enum", () => {
    const after = harnesses(
      inputEnum(["claude", "codex", "opencode"], { since: { opencode: 7 } }).nullable(),
    )
    const before = harnesses(z.enum(["claude", "codex"]).nullable())
    const verdict = judgeContract(snap(before, window(3, 3, 2)), snap(after, window(7, 3, 2)))
    expect(verdict.findings).toEqual([])
    expect(verdict.gated).toEqual(['agents.open input/harness "opencode" since 7'])
  })

  it("refuse an unmarked new value, as before", () => {
    const after = harnesses(z.enum(["claude", "codex", "opencode"]))
    expect(runner(after).map(({ reason }) => reason)).toEqual([
      'takes "opencode", beyond "claude", "codex"',
    ])
    // A mark that names another value leaves this one unmarked.
    const other = harnesses(inputEnum(["claude", "codex", "opencode"], { since: { claude: 7 } }))
    expect(runner(other).length).toBeGreaterThan(0)
  })

  it("refuse a mark that names a revision the release had", () => {
    const after = harnesses(inputEnum(["claude", "codex", "opencode"], { since: { opencode: 3 } }))
    expect(runner(after).map(({ reason }) => reason)).toEqual([
      'takes "opencode", beyond "claude", "codex"',
    ])
  })

  it("refuse a mark on a value the release already had", () => {
    const after = harnesses(inputEnum(["claude", "codex"], { since: { codex: 7 } }))
    expect(runner(after).map(({ reason }) => reason)).toEqual([
      'is marked since 7 on "codex", which the release already had',
    ])
  })

  it("hold a released mark as it was", () => {
    const marked = (since: number | undefined) =>
      harnesses(
        inputEnum(["claude", "codex", "opencode"], {
          since: since === undefined ? {} : { opencode: since },
        }),
      )
    // The release (revision 7) already had opencode, marked.
    const release = snap(marked(7), window(7, 3, 2))
    const check = (after: object) =>
      judgeContract(release, snap(after, window(8, 3, 2))).findings.map(({ reason }) => reason)
    expect(check(marked(7))).toEqual([])
    expect(check(marked(8))).toEqual(['changed or lost the since mark a release had on "opencode"'])
    expect(check(marked(undefined))).toEqual([
      'changed or lost the since mark a release had on "opencode"',
    ])
  })

  it("refuse a mark past the revision", () => {
    const after = harnesses(inputEnum(["claude", "codex", "opencode"], { since: { opencode: 9 } }))
    expect(compare(after, window(7, 3, 2)).problems).toEqual([
      'agents.open input/harness "opencode" is marked since 9, past the revision (7).',
    ])
  })

  it("let a union input gain a marked variant, and refuse an unmarked one", () => {
    const union = (variants: string[], since: Record<string, number>) =>
      harnesses(
        inputUnion(
          "kind",
          variants.map((kind) => z.strictObject({ kind: z.literal(kind) })) as never,
          { since },
        ),
      )
    const before = snap(union(["a", "b"], {}), window(3, 3, 2))
    const marked = judgeContract(before, snap(union(["a", "b", "c"], { c: 7 }), window(7, 3, 2)))
    expect(marked.findings).toEqual([])
    expect(marked.gated).toEqual(['agents.open input/harness "c" since 7'])
    const unmarked = judgeContract(before, snap(union(["a", "b", "c"], {}), window(7, 3, 2)))
    expect(unmarked.findings.map(({ reason }) => reason)).toEqual([
      'adds the "c" variant of "kind"',
    ])
    const known = judgeContract(before, snap(union(["a", "b"], { b: 7 }), window(7, 3, 2)))
    expect(known.findings.map(({ reason }) => reason)).toEqual([
      'is marked since 7 on "b", which the release already had',
    ])
  })
})

describe("judgeContract", () => {
  const changed = withSave(z.strictObject({ ...saveFields, base: z.number().int().optional() }))
  const dropped = withGet(z.strictObject({ id: z.uuid(), name: z.string().max(80) }))

  it("passes an unchanged contract that keeps its revision", () => {
    expect(judgeContract(snap(base), snap(base)).problems).toEqual([])
  })

  it("asks for a raised revision when the contract changed", () => {
    expect(judgeContract(snap(base), snap(changed)).problems).toEqual([
      "The contract changed since revision 2, but revision is still 2: raise it to 3.",
    ])
  })

  it("passes an additive change under a raised revision", () => {
    expect(judgeContract(snap(base), snap(changed, window(3, 2, 2))).problems).toEqual([])
  })

  it("asks to move an edge for a change that leaves that side behind", () => {
    const { problems } = judgeContract(snap(base), snap(dropped, window(3, 2, 2)))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/leave UIs of revision 2 behind, but oldestClient is 2/)
  })

  it("passes once the edge moved past the release's revision", () => {
    expect(judgeContract(snap(base), snap(dropped, window(3, 3, 2))).problems).toEqual([])
  })

  it("refuses an edge that falls back or runs past the revision", () => {
    expect(judgeContract(snap(base, window(3)), snap(base, window(3, 2, 4))).problems).toEqual([
      "oldestClient fell from 3 to 2: an edge only moves forward.",
      "oldestRunner (4) is past the revision (3).",
    ])
  })

  it("refuses a `since` past the revision", () => {
    const gated = {
      ...base,
      sessions: {
        ...base.sessions,
        drop: call.meta({ since: 5 }).input(z.void()).output(z.void()),
      },
    }
    expect(judgeContract(snap(base), snap(gated, window(3, 2, 2))).problems).toEqual([
      "sessions.drop is marked since: 5, past the revision (3).",
    ])
  })
})

describe("judgeReleases", () => {
  // An optional field gone in one release and back with another type in the next: each step
  // passes against the release before, and the first release's peers, still in the window, break.
  const step = (field: z.ZodType | undefined) => ({
    sessions: {
      save: call
        .input(z.strictObject({ id: z.uuid(), ...(field && { note: field.optional() }) }))
        .output(z.strictObject({ ...(field && { note: field.optional() }) })),
    },
  })
  const two = snap(step(z.string()), window(2))
  const three = snap(step(undefined), window(3, 2, 2))
  const four = snap(step(z.number()), window(4, 2, 2))

  it("passes each step against the release before", () => {
    expect(judgeContract(two, three).problems).toEqual([])
    expect(judgeContract(three, four).problems).toEqual([])
  })

  it("fails it against an older release still in the window", () => {
    const verdict = judgeReleases(
      [
        { ref: "v1.3.0", contract: three },
        { ref: "v1.2.0", contract: two },
      ],
      four,
    )
    expect(verdict.older.map(({ ref }) => ref)).toEqual(["v1.2.0"])
    expect(verdict.problems).toHaveLength(2)
    expect(verdict.problems[0]).toMatch(/UIs of revision 2 \(v1.2.0\) behind/)
  })

  it("passes once the window has moved past that release", () => {
    const moved = { ...four, oldestClient: 3, oldestRunner: 3 }
    expect(
      judgeReleases(
        [
          { ref: "v1.3.0", contract: three },
          { ref: "v1.2.0", contract: two },
        ],
        moved,
      ).problems,
    ).toEqual([])
  })
})
