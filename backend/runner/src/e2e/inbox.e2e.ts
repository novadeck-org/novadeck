import { join } from "node:path"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool, type Call } from "./model/script.js"
import { delivered, own, replies, result, start, through, turn } from "./scenarios.js"

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// The schema the model actually sees, after its harness translated the MCP declaration.
// Antigravity loads it lazily: read_file's result is the model's copy, not the runner's.
const parameters = (call: Call, name: string, reading: boolean): unknown => {
  if (reading) {
    const lines =
      result(call)
        ?.split("\n")
        .filter((line) => /^\d+: /.test(line)) ?? []
    return record(JSON.parse(lines.map((line) => line.replace(/^\d+: /, "")).join("\n"))).parameters
  }
  const offered = (call.rawTools ?? [])
    .flatMap((value) => {
      const item = record(value)
      return Array.isArray(item.tools)
        ? item.tools
        : Array.isArray(item.functionDeclarations)
          ? item.functionDeclarations
          : [item]
    })
    .map(record)
    .find((item) => item.name === name || item.name === "ask")
  return offered?.parameters ?? offered?.input_schema ?? offered?.parametersJsonSchema
}

const usable = (schema: unknown) => {
  const kind = (type: string) =>
    expect.toSatisfy((value: unknown) => {
      const item = record(value)
      return (
        item.const === type ||
        (item.type === "string" && JSON.stringify(item.enum) === JSON.stringify([type]))
      )
    })
  expect(schema).toMatchObject({
    type: "object",
    properties: {
      shape: {
        oneOf: [
          { type: "object", properties: { type: kind("text") }, required: ["type"] },
          {
            type: "object",
            properties: {
              type: kind("options"),
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    summary: { type: "string" },
                    details: { type: "string" },
                    code: {
                      type: "object",
                      properties: { path: { type: "string" }, text: { type: "string" } },
                    },
                  },
                },
              },
              recommend: { type: ["integer", "null"] },
            },
            required: ["type", "options"],
          },
          {
            type: "object",
            properties: {
              type: kind("action"),
              command: { type: "string" },
              directory: { type: "string" },
              done_label: { type: "string" },
            },
            required: ["type", "command", "done_label"],
          },
        ],
      },
    },
  })
}

// The same MCP tools and message path for every supported harness.
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    it("asks and tells through Inbox immediately, then receives the person's answer as a message", async ({
      e2e: run,
    }) => {
      run.model.use(
        own((call) => {
          if (delivered(call, "you")) return { text: "I received your Inbox answer: green." }
          const reading =
            call.turns.at(-1)?.role === "tool" &&
            call.turns
              .findLast((entry) => entry.role === "assistant")
              ?.calls.some(
                (entry) =>
                  entry.name === "read_file" && /[/\\]ask\.json$/.test(String(entry.input.Path)),
              ) === true
          if (asked(call, "Ask through Inbox") && call.tools.includes("call_mcp_tool")) {
            const folder = /directory `([^`]+)[/\\]<serverName>`/.exec(call.system)?.[1]
            if (!folder) throw new Error("Antigravity named no MCP schema folder")
            return {
              calls: [
                {
                  name: "read_file",
                  input: { Path: join(folder, "novadeck_novadeck", "ask.json") },
                },
              ],
            }
          }
          if (asked(call, "Ask through Inbox") || reading) {
            const name = tool(call, "ask")
            if (!name)
              throw new Error(
                "Novadeck's ask tool is missing; offered: " +
                  JSON.stringify(call.tools.filter((offered) => /novadeck|search/i.test(offered))),
              )
            usable(parameters(call, name, reading))
            return {
              calls: [
                {
                  name,
                  input: {
                    subject: "Which colour should the heading use?",
                    body: "I can keep working while you choose.",
                    hard_to_undo: "The public theme uses this colour.",
                    shape: {
                      type: "options",
                      options: [
                        {
                          label: "Blue",
                          summary: "Calm",
                          details: "Matches the existing palette.",
                          code: { path: "theme.css", text: "--heading: blue;" },
                        },
                        { label: "Green", summary: "Bright" },
                      ],
                      recommend: 0,
                    },
                  },
                },
              ],
            }
          }
          if (
            result(call)?.includes(
              " is in the user's Inbox. Their answer arrives later as a message",
            )
          ) {
            const name = tool(call, "tell")
            if (!name)
              throw new Error(
                "Novadeck's tell tool is missing; offered: " +
                  JSON.stringify(call.tools.filter((offered) => /novadeck|search/i.test(offered))),
              )
            return {
              calls: [
                {
                  name,
                  input: {
                    subject: "Other work is ready",
                    body: "The tests pass while the colour waits.",
                  },
                },
              ],
            }
          }
          if (/Update [a-f0-9-]+ is in the user's Inbox/.test(result(call) ?? ""))
            return { text: "I continued without waiting for the answer." }
          return undefined
        }),
      )
      const terminal = await start(run, setup)
      // Reaching a final reply before answering proves ask did not wait synchronously.
      await turn(terminal, "Ask through Inbox", "I continued without waiting for the answer.")
      const entries = run.deck.terminals.inboxEntries()
      const ask = entries.find((each) => each.content.kind === "ask")!
      const told = entries.find((each) => each.content.kind === "tell")!
      expect(ask.terminalId).toBe(terminal.id)
      expect(ask.content).toMatchObject({
        kind: "ask",
        ask: {
          shape: {
            type: "options",
            recommend: 0,
            options: [{ label: "Blue" }, { label: "Green" }],
          },
        },
      })
      expect(told.terminalId).toBe(terminal.id)
      const before = terminal.messages().threads.filter((thread) => thread.peer === "you")
      expect(before).toHaveLength(2)
      expect(
        before
          .flatMap((thread) => thread.messages)
          .every((message) => message.state === "delivered"),
      ).toBe(true)
      run.deck.terminals.readTells([told.id])
      // The agent's finished turn is an entry too, stored once it rests: not what is asked here.
      const waiting = () =>
        run.deck.terminals.inboxEntries().filter((each) => each.content.kind !== "turn")
      expect(waiting().map((each) => each.id)).toEqual([ask.id])
      const mark = terminal.mark()
      // This is the same runner operation that the authenticated UI's inbox.answer calls.
      run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 1, text: "Use green, please." })
      expect(() =>
        run.deck.terminals.answerAsk(ask.id, { type: "reply", option: null, text: "Again" }),
      ).toThrow(/no longer/)
      expect(waiting()).toEqual([])
      await terminal.until("I received your Inbox answer: green.")
      await through(terminal, ["settled"], { after: mark })
      const received = await run.model.waitFor((call) => !call.side && delivered(call, "you"))
      const text = [received.system, ...received.turns.map((entry) => entry.text)].join("\n")
      expect(text).toMatch(/person=['"][A-Za-z0-9]{8}['"]/)
      expect(text).toContain("Novadeck relayed the user's response")
      expect(text).toContain("Use green, please.")
      const history = terminal.messages().threads.flatMap((thread) => thread.messages)
      expect(history.filter((message) => message.inbox === "answer")).toMatchObject([
        {
          from: "you",
          to: terminal.handle,
          state: "delivered",
          text: "Green\n\nUse green, please.",
        },
      ])
      expect(history.find((message) => message.inbox === "ask")?.text).toContain(
        "theme.css\n--heading: blue;",
      )
      expect(history.some((message) => message.inbox === "tell")).toBe(true)
    })

    it("lists a peer's done to other agents until its next prompt, then as its latest update", async ({
      e2e: run,
    }) => {
      // A tool is named as any terminal's request offers it: one may go out before its
      // MCP tools load.
      const named = (call: Call, name: string): string => {
        const found = [call, ...run.model.calls].map((one) => tool(one, name)).find(Boolean)
        if (!found) throw new Error(`Novadeck's ${name} tool is missing`)
        return found
      }
      const listings: string[] = []
      run.model.use(
        own((call) => {
          if (asked(call, "Finish up"))
            return {
              calls: [
                {
                  name: named(call, "done"),
                  input: { subject: "Fixed the login bug", body: "All green." },
                },
              ],
            }
          if (/Report [a-f0-9-]+ is in the user's Inbox/.test(result(call) ?? ""))
            return { text: "Reported it done." }
          if (asked(call, "Look around") || asked(call, "Look again"))
            return { calls: [{ name: named(call, "agents"), input: {} }] }
          const listing = result(call)
          if (listing?.includes("Other terminals in this project and session")) {
            listings.push(listing)
            return { text: `Looked ${listings.length}.` }
          }
          return undefined
        }),
        replies("Next task", "On the next task."),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)

      await turn(t2, "Finish up", "Reported it done.")
      await turn(t1, "Look around", "Looked 1.")
      expect(listings[0]).toMatch(/\n {2}reported done [^:\n]+: Fixed the login bug\n?/)
      expect(listings[0]).not.toContain("latest update")

      // The person's next prompt gave it more to do: the done is only its latest update now.
      await turn(t2, "Next task", "On the next task.")
      await turn(t1, "Look again", "Looked 2.")
      expect(listings[1]).toMatch(/\n {2}latest update [^:\n]+: Fixed the login bug\n?/)
      expect(listings[1]).not.toContain("reported done")
    })

    it("shows an action ask and receives its confirmation as a message", async ({ e2e: run }) => {
      run.model.use(
        own((call) => {
          if (delivered(call, "you")) return { text: "I received your action confirmation." }
          if (asked(call, "Ask for an action")) {
            const name = tool(call, "ask")
            if (!name) throw new Error("Novadeck's ask tool is missing")
            return {
              calls: [
                {
                  name,
                  input: {
                    subject: "Sign in to the preview service",
                    body: "Run this in a terminal, then confirm when you have signed in.",
                    shape: {
                      type: "action",
                      command: "preview login",
                      directory: run.sandbox.project,
                      done_label: "I signed in",
                    },
                  },
                },
              ],
            }
          }
          if (result(call)?.includes(" is in the user's Inbox."))
            return { text: "I continued while you sign in." }
          return undefined
        }),
      )
      const terminal = await start(run, setup)
      await turn(terminal, "Ask for an action", "I continued while you sign in.")
      const action = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
      expect(action.content).toMatchObject({
        kind: "ask",
        ask: {
          shape: {
            type: "action",
            command: "preview login",
            directory: run.sandbox.project,
            doneLabel: "I signed in",
          },
        },
      })
      const confirmation = terminal.mark()
      run.deck.terminals.answerAsk(action.id, { type: "done" })
      await terminal.until("I received your action confirmation.")
      await through(terminal, ["settled"], { after: confirmation })
      expect(terminal.messages().threads.flatMap((thread) => thread.messages)).toContainEqual(
        expect.objectContaining({
          inbox: "answer",
          from: "you",
          state: "delivered",
          text: "I signed in",
        }),
      )
    })
  })
}
