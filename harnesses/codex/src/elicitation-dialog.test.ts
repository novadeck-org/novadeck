import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { asks, load, probe, screen, sizes } from "./dialogs.test-support.js"

type Form = {
  readonly screens: Record<string, ScreenText>
  readonly steps: Record<string, ScreenText>
  readonly after: ScreenText
  readonly toolResult: string
  readonly novadeckSaw: unknown[]
}
const { forms } = loadProbe<{ forms: Record<string, Form> }>(
  import.meta.dirname,
  "elicitation.probe.json",
)

const asked = (rows: readonly string[]) => dialogs.screenRequest!(rows)

const request = (message: string, server: string | null = "probe") => ({
  kind: "question",
  tool: server === null ? "mcp__elicitation" : `mcp__${server}__elicitation`,
  input: { mcp_server_name: server, message },
  subject: message,
})

describe("an MCP server's form in Codex", () => {
  it("fires no hook: no request waited for it", () => {
    for (const form of Object.values(forms)) expect(form.novadeckSaw).toEqual([])
    expect(asks("mcp-elicitation")).toEqual([])
  })

  describe("as questions it takes, a field at a time", () => {
    it("is the server's question, about its message, at every size", () => {
      const messages = { enum: "Which colour do you want?", text: "What is your name?" }
      for (const [name, message] of Object.entries(messages))
        for (const shown of Object.values(forms[name]!.screens))
          expect(asked(shown.rows)).toEqual(request(message))
    })

    it("stays the one request from field to field, its footer wrapped or not", () => {
      const two = forms.two!
      for (const shown of [...Object.values(two.screens), two.steps['0:{"submit":"one"}']!])
        expect(asked(shown.rows)).toEqual(request("Name two things"))
    })

    it("as an earlier release drew it, the server named by its call", () => {
      // Its record (0.163.0) kept no blank rows, so the field's rows run on after the message.
      for (const size of sizes)
        expect(asked(screen("mcp-elicitation", size))).toMatchObject({
          kind: "question",
          tool: "mcp__probe__elicitation",
          subject: expect.stringMatching(/^Which color do you want\? /),
        })
    })

    it("names no server where its call has scrolled away", () => {
      const rows = forms.enum!.screens["50x20"]!.rows.map((row) =>
        /Calling probe\.form/.test(row) ? "" : row,
      )
      expect(asked(rows)).toEqual(request("Which colour do you want?", null))
    })

    it("is not an MCP tool's approval, which its hook asks for and is drawn the same", () => {
      for (const size of sizes) expect(asked(screen("mcp-tool-approval", size))).toBeUndefined()
    })
  })

  describe("as an approval, for fields it can't take as questions", () => {
    it("is the server's question, about its message, at every size", () => {
      for (const shown of Object.values(forms.mixed!.screens))
        expect(asked(shown.rows)).toEqual(request("Tell us about yourself"))
    })

    it("is none where an option reads otherwise", () => {
      const rows = forms.mixed!.screens["120x40"]!.rows.map((row) =>
        row.replace("No, but continue without it", "No, continue"),
      )
      expect(asked(rows)).toBeUndefined()
    })
  })

  it("is gone once answered or cancelled, the call's result in its place", () => {
    for (const form of Object.values(forms)) {
      expect(form.toolResult).toContain("elicitation result: ")
      expect(asked(form.after.rows)).toBeUndefined()
    }
  })

  it("is no other dialog any probe saw", () => {
    const kinds = [probe, load("ask.probe.0.160.1.json")].flatMap((source) =>
      Object.entries(source.scenarios).flatMap(([name, scenario]) =>
        [
          ...Object.values(scenario.screens ?? {}),
          ...(scenario.screen ? [scenario.screen] : []),
        ].map((shown) => [name, asked(shown.rows)?.kind ?? null] as const),
      ),
    )
    expect(kinds.filter(([, kind]) => kind === "question")).toEqual(
      kinds.filter(([name]) => name === "mcp-elicitation"),
    )
    expect(
      kinds.filter(([name, kind]) => kind === "question" && name !== "mcp-elicitation"),
    ).toEqual([])
  })
})
