import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import type { RequestAnswer } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import {
  choice,
  Down,
  eventually,
  factsOf,
  need,
  never,
  pressed,
  readOf,
  Right,
  screen,
  step,
  swap,
  typed,
  waits,
} from "./dialogs.test-support.js"
import { claude } from "./index.js"

const fill = (values: object, action: "accept" | "decline" = "accept"): RequestAnswer =>
  ({ type: "form", dialog: "d", action, values }) as RequestAnswer

describe("Claude Code's MCP elicitation forms", () => {
  it("reads each kind of field, as the probes drew it", () => {
    expect(need(readOf("form-text", "120x40")).dialog).toEqual({
      type: "form",
      message: "What is your name?",
      fields: [
        { id: "name", label: "Name", description: null, kind: "text", choices: [], required: true },
      ],
    })
    expect(need(readOf("form-two", "120x40")).dialog).toMatchObject({
      message: "Tell us about yourself",
      fields: [
        { id: "name", description: "Your full name", required: true },
        { id: "nick", description: null, required: false },
      ],
    })
    expect(need(readOf("form-mixed", "120x40")).dialog).toMatchObject({
      fields: [
        { id: "name", kind: "text", required: true },
        { id: "age", kind: "number", required: false },
        { id: "ok", kind: "boolean", required: false },
        { id: "colour", kind: "choice", choices: ["red", "green"], required: false },
      ],
    })
    for (const name of [
      "form-number",
      "form-boolean",
      "form-enum",
      "form-layout-a",
      "form-layout-b",
    ]) {
      expect(readOf(name, "120x40"), name).toBeDefined()
    }
    expect(readOf("form-text", "60x20")).toBeDefined()
  })

  it("refuses a form cut short or truncated by the screen's width", () => {
    // Fields below the fold ("↓ 3 more below"), an ellipsis in the message or a title.
    expect(readOf("form-layout-a", "60x20")).toBeUndefined()
    expect(readOf("form-layout-long", "120x40")).toBeUndefined()
    expect(readOf("form-layout-long", "60x20")).toBeUndefined()
  })

  it("types into the highlighted field, moves with Down, and accepts after the highlight settles", () => {
    const dialog = need(readOf("form-keys-two", "120x40"))
    const keys = dialog.keys(fill({ name: "Ada", nick: "Ace" }))
    expect(pressed(keys)).toEqual([Down, Down, "\r"])
    expect(typed(keys)).toEqual(["Ada", "Ace"])
    const [name, second, nick, accept] = waits(keys)
    expect(eventually(name, step("form-keys-two", "typed-name"))).toBe(true)
    expect(never(name, screen("form-two", "120x40"))).toBe(false)
    expect(eventually(second, step("form-keys-two", "down-1"))).toBe(true)
    expect(eventually(nick, step("form-keys-two", "typed-nick"))).toBe(true)
    expect(eventually(accept, step("form-keys-two", "down-2"))).toBe(true)
    expect(never(accept, step("form-keys-two", "typed-nick"))).toBe(false)
  })

  it("leaves an optional field unset by moving past it", () => {
    const dialog = need(readOf("form-two", "120x40"))
    expect(pressed(dialog.keys(fill({ name: "Ada" })))).toEqual([Down, Down, "\r"])
    expect(typed(dialog.keys(fill({ name: "Ada" })))).toEqual(["Ada"])
  })

  it("ticks a boolean, picks an enum value, and types a number", () => {
    const dialog = need(readOf("form-mixed", "120x40"))
    const keys = dialog.keys(fill({ name: "Ada", age: 30, ok: true, colour: "green" }))
    expect(pressed(keys)).toEqual([Down, Down, " ", Down, Right, Down, " ", Down, "\r"])
    expect(typed(keys)).toEqual(["Ada", "30"])
    const all = waits(keys)
    // Accept highlighted with everything set is where Enter waits.
    expect(eventually(all.at(-1), step("form-accept-all", "submitted"))).toBe(true)
    expect(never(all.at(-1), step("form-accept-all", "filled"))).toBe(false)
    // The enum's wait for its expanded options, and for the set value.
    expect(
      eventually(
        all.find((_, at) => at === 8),
        step("form-keys-bool-enum", "expanded"),
      ),
    ).toBeDefined()
    // A bool cleared is two spaces, true once.
    const off = need(readOf("form-boolean", "120x40")).keys(fill({ sub: false }))
    expect(pressed(off)).toEqual([" ", " ", Down, "\r"])
    expect(pressed(need(readOf("form-boolean", "120x40")).keys(fill({ sub: true })))).toEqual([
      " ",
      Down,
      "\r",
    ])
  })

  it("fails a wait when a key landed on the wrong field, not only when it was lost", () => {
    const dialog = need(readOf("form-keys-two", "120x40"))
    const keys = dialog.keys(fill({ name: "Ada" }))
    const [typedName, , accept] = waits(keys)
    expect(eventually(typedName, step("form-keys-two", "typed-name"))).toBe(true)
    // The words went to the next field as well, or instead: not what was asked.
    expect(never(typedName, step("form-keys-two", "typed-nick"))).toBe(false)
    // Accept highlighted, but a field the answer leaves alone was filled.
    expect(never(accept, step("form-keys-two", "down-2"))).toBe(false)
    const flipped = need(readOf("form-required-bool", "120x40")).keys(fill({ sub: false }))
    const [ticked, cleared] = waits(flipped)
    expect(eventually(ticked, step("form-required-bool", "space-1"))).toBe(true)
    expect(eventually(cleared, step("form-required-bool", "space-2"))).toBe(true)
    // A Space that toggled the field left behind: the first one back to ticked, the next
    // field showing no change from a Space of its own.
    expect(never(cleared, step("form-required-bool", "optional-space-1"))).toBe(false)
  })

  it("keeps a field's description under it whether or not it is highlighted", () => {
    for (const name of ["form-described", "form-described@2.1.291"]) {
      const dialog = need(readOf(name, "120x40"))
      expect(dialog.dialog).toMatchObject({
        fields: [{ description: "Your full name" }, { description: "What friends call you" }],
      })
      const keys = dialog.keys(fill({ name: "Ada", nick: "Ace" }))
      const [typedName, second, typedNick, accept] = waits(keys)
      expect(eventually(typedName, step(name, "typed-name")), name).toBe(true)
      expect(eventually(second, step(name, "down-1")), name).toBe(true)
      expect(eventually(typedNick, step(name, "typed-nick")), name).toBe(true)
      expect(eventually(accept, step(name, "down-2")), name).toBe(true)
      // A description that went missing is not the form that was read.
      const without = step(name, "down-2").filter((row) => !row.includes("Your full name"))
      expect(never(accept, without), name).toBe(false)
    }
  })

  it("takes words sent as a bracketed paste as it takes typed ones", () => {
    const dialog = need(readOf("form-paste", "120x40"))
    const keys = dialog.keys(fill({ name: "Ada Lovelace", n: 42 }))
    const [name, second, number] = waits(keys)
    expect(eventually(name, step("form-paste", "pasted-name"))).toBe(true)
    expect(second).toBeDefined()
    expect(eventually(number, step("form-paste", "pasted-number"))).toBe(true)
  })

  it("declines from any field by going down to the buttons and right", () => {
    const dialog = need(readOf("form-text", "120x40"))
    const keys = dialog.keys(fill({}, "decline"))
    expect(pressed(keys)).toEqual([Down, Right, "\r"])
    const [onAccept, onDecline] = waits(keys)
    expect(eventually(onAccept, step("form-decline", "on-accept"))).toBe(true)
    expect(never(onAccept, screen("form-text", "120x40"))).toBe(false)
    expect(onDecline).toBeDefined()
    expect(dialog.keys(fill({ name: "Ada" }, "decline"))).toBeUndefined()
  })

  it("refuses answers a form can't take", () => {
    const dialog = need(readOf("form-mixed", "120x40"))
    expect(dialog.keys(fill({}))).toBeUndefined()
    expect(dialog.keys(fill({ name: "" }))).toBeUndefined()
    expect(dialog.keys(fill({ name: "two\nlines" }))).toBeUndefined()
    expect(dialog.keys(fill({ name: "Ada", unknown: "x" }))).toBeUndefined()
    expect(dialog.keys(fill({ name: "Ada", age: "30" }))).toBeUndefined()
    expect(dialog.keys(fill({ name: "Ada", age: Number.NaN }))).toBeUndefined()
    expect(dialog.keys(fill({ name: "Ada", age: 1e21 }))).toBeUndefined()
    expect(dialog.keys(fill({ name: "Ada", ok: "yes" }))).toBeUndefined()
    expect(dialog.keys(fill({ name: "Ada", colour: "purple" }))).toBeUndefined()
    expect(dialog.keys(choice("1"))).toBeUndefined()
  })

  it("is answered once the prompt is back and the form's heading gone", () => {
    const dialog = need(readOf("form-text", "120x40"))
    expect(dialog.answered(step("form-decline", "declined"))).toBe(true)
    expect(dialog.answered(step("form-accept-text", "submitted"))).toBe(true)
    expect(dialog.answered(screen("form-text", "120x40"))).toBe(false)
    expect(dialog.answered(step("form-keys-two", "typed-name"))).toBe(false)
    expect(dialog.answered([])).toBe(false)
    // A half-drawn frame: the form gone, the prompt not back.
    expect(dialog.answered(["", "  Called probe"])).toBe(false)
  })

  it("refuses a form that isn't the request's, or has been touched", () => {
    const facts = factsOf("form-two")
    const rows = screen("form-two", "120x40")
    const schema = (facts.input as { requested_schema: { properties: { [id: string]: object } } })
      .requested_schema
    const withInput = (change: (input: Record<string, unknown>) => void): RequestFacts => {
      const input = structuredClone(facts.input) as Record<string, unknown>
      change(input)
      return { ...facts, input }
    }
    const props = (input: Record<string, unknown>) =>
      (input.requested_schema as typeof schema).properties as {
        [id: string]: Record<string, unknown>
      }
    expect(dialogs.read(rows, facts)).toBeDefined()
    const cases: { [name: string]: RequestFacts } = {
      "another message": withInput((i) => (i.message = "Tell us more")),
      "another server": withInput((i) => (i.mcp_server_name = "other")),
      "a renamed title": withInput((i) => (props(i).name!.title = "Full name")),
      "another description": withInput((i) => (props(i).name!.description = "Else")),
      "a field the screen lacks": withInput(
        (i) => (props(i).extra = { type: "string", title: "Extra" }),
      ),
      "another requirement": withInput(
        (i) => ((i.requested_schema as { required: string[] }).required = ["nick"]),
      ),
      "a format": withInput((i) => (props(i).name!.format = "email")),
      "a limit": withInput((i) => (props(i).name!.maxLength = 3)),
      "a default": withInput((i) => (props(i).name!.default = "x")),
      "an integer": withInput((i) => (props(i).name!.type = "integer")),
      "an untitled field": withInput((i) => delete props(i).name!.title),
      "no schema": withInput((i) => delete i.requested_schema),
      "a url mode": withInput((i) => (i.mode = "url")),
      "no input": { ...facts, input: undefined },
      "another tool": { ...facts, tool: "mcp__other__elicitation" },
      "a permission's kind": { ...facts, kind: "permission" },
    }
    for (const [name, each] of Object.entries(cases)) {
      expect(dialogs.read(rows, each), name).toBeUndefined()
    }
    // Touched, or past its fields: not the state it was read in.
    expect(dialogs.read(step("form-keys-two", "typed-name"), facts)).toBeUndefined()
    expect(dialogs.read(step("form-keys-two", "down-2"), facts)).toBeUndefined()
    expect(dialogs.read(step("form-keys-two", "down-1"), facts)).toBeUndefined()
    expect(
      dialogs.read(step("form-accept-missing", "enter-on-accept"), factsOf("form-text")),
    ).toBeUndefined()
  })

  it("refuses a form an update changed", () => {
    const facts = factsOf("form-mixed")
    const rows = screen("form-mixed", "120x40")
    const mutations: { [name: string]: string[] } = {
      "a changed heading": swap(rows, "requests your input", "wants input"),
      "straight quotes": swap(rows, "“probe”", '"probe"'),
      "another marker": swap(rows, "❯ * Name", "> * Name"),
      "a second marker": swap(rows, "    Age: not set", "  ❯ Age: not set"),
      "another required mark": swap(rows, "* Name", "! Name"),
      "another unset wording": swap(rows, "Age: not set", "Age: empty"),
      "another placeholder": swap(rows, "Type something…", "Type here…"),
      "no Accept": swap(rows, "Accept    Decline", "Submit    Decline"),
      "another footer": swap(
        rows,
        "Esc to cancel · ↑/↓ to navigate",
        "Esc to close · ↑/↓ to navigate",
      ),
      "an unknown row": rows.flatMap((row) =>
        row.includes("Agree:") ? ["        Something new", row] : [row],
      ),
      "no footer": rows.filter((row) => !row.includes("Esc to cancel")),
      "text after the footer": [...rows, "  something else"],
    }
    for (const [name, mutated] of Object.entries(mutations)) {
      expect(dialogs.read(mutated, facts), name).toBeUndefined()
    }
  })
})

const report = (event: string, payload: object) => ({
  terminalId: "t",
  token: "k",
  agent: "claude" as const,
  event,
  seq: 1,
  instance: "7",
  env: { cursor: false },
  payload: { session_id: "s", ...payload },
})

describe("Claude Code's elicitation hooks", () => {
  it("raise a question named for the server, with the form as input, and settle it", () => {
    const asked = {
      mcp_server_name: "probe",
      message: "What is your name?",
      mode: "form",
      requested_schema: { type: "object", properties: { name: { type: "string", title: "Name" } } },
    }
    const [requested] = decode(report("Elicitation", asked))
    expect(requested).toMatchObject({
      type: "attention-requested",
      kind: "question",
      toolName: "mcp__probe__elicitation",
      subject: "What is your name?",
      input: asked,
    })
    const [resolved] = decode(
      report("ElicitationResult", { mcp_server_name: "probe", mode: "form", action: "decline" }),
    )
    expect(resolved).toMatchObject({
      type: "attention-resolved",
      toolName: "mcp__probe__elicitation",
      loose: true,
    })
    expect(decode(report("Elicitation", { message: "x" }))).toEqual([])
  })

  it("are registered, and answer nothing", () => {
    const hooks = JSON.parse(
      claude
        .files("linux", { mcp: { command: "/m" } } as never)
        .find((each) => each.path.endsWith("hooks.json"))!.content,
    ) as { hooks: { [event: string]: unknown } }
    expect(Object.keys(hooks.hooks)).toEqual(
      expect.arrayContaining(["Elicitation", "ElicitationResult"]),
    )
    expect(claude.messaging.asks).not.toHaveProperty("Elicitation")
    expect(claude.messaging.asks).not.toHaveProperty("ElicitationResult")
  })
})
