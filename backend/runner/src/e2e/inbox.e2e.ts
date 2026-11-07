import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { harnesses } from "../harnesses/registry.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { agentsViewOutlivesDeck, losesLineBreakKeys } from "./known-gaps.js"
import { asked, gate, record, text as allOf, tool, type Call, type Rule } from "./model/script.js"
import { delivered, own, replies, result, start, through, turn, unrung } from "./scenarios.js"

// The schema the model actually sees, after its harness translated the MCP declaration.
// Antigravity loads it lazily: read_file's result is the model's copy, not the runner's.
const parameters = (call: Call, name: string, reading: boolean): unknown => {
  if (reading) {
    const lines =
      result(call)
        ?.split("\n")
        .filter((line) => /^\d+: /.test(line)) ?? []
    // A failed read has no numbered lines, and parsing nothing would only fail as a bad body.
    if (lines.length === 0) throw new Error("read_file gave no schema: " + result(call))
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
            const named = /directory `([^`]+)[/\\]<serverName>`/.exec(call.system)?.[1]
            if (!named) throw new Error("Antigravity named no MCP schema folder")
            // 1.4.3 names the folder in full. 1.4.7 names it under a literal `<appDataDir>`
            // that read_file refuses as "not an absolute path", and gives that folder on its
            // own line of the system prompt, for the model to put in (probed 2026-10-27).
            const home = /^App Data Directory: (.+)$/m.exec(call.system)?.[1]?.trim()
            if (named.includes("<appDataDir>") && !home)
              throw new Error("Antigravity named no app data directory")
            const folder = home ? named.replace("<appDataDir>", () => home) : named
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
          if (/Ask [a-f0-9-]+ is in the user's Inbox\./.test(result(call) ?? "")) {
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
      const before = terminal.messages().threads.filter((thread) => thread.peer.kind === "person")
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
      // Their words hold what the line must carry safely: @ and $, and letters past ASCII.
      run.deck.terminals.answerAsk(ask.id, {
        type: "reply",
        option: 1,
        text: "Use green, please: zażółć, @flint, $5.",
      })
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
      expect(text).toContain("Use green, please: zażółć, @flint, $5.")
      // The doorbell typed the reply as the person's own prompt, which the harness sent as
      // a user turn: what an approval check that reads only the person's words sees.
      expect(
        received.turns.some(
          (entry) =>
            entry.role === "user" &&
            /\[Novadeck Inbox reply, ([A-Za-z0-9]+)\] Re your ask "Which colour should the heading use\?": I picked "Green" and wrote: Use green, please: zażółć, ＠flint, ＄5\. \[\1\]/.test(
              entry.text,
            ),
        ),
      ).toBe(true)
      // Its record follows what the model got, so it's waited for.
      const line = await terminal.poll(
        async () => (await terminal.transcript()).find((item) => item.ring !== null),
        "the reply line in its transcript",
      )
      expect(line.ring).toMatchObject({ replies: true })
      const history = terminal.messages().threads.flatMap((thread) => thread.messages)
      expect(history.filter((message) => message.inbox === "answer")).toMatchObject([
        {
          from: { kind: "person" },
          to: { kind: "agent", handle: terminal.handle, agent: expect.anything() },
          state: "delivered",
          text: "Green\n\nUse green, please: zażółć, @flint, $5.",
        },
      ])
      expect(history.find((message) => message.inbox === "ask")?.text).toContain(
        "theme.css\n--heading: blue;",
      )
      expect(history.some((message) => message.inbox === "tell")).toBe(true)
    })

    // The model for a turn that asks the person and works on, its last reply held until
    // `finishing` opens, and that says when it holds their reply.
    const asksAndWorksOn = (run: E2E, finishing: ReturnType<typeof gate>): Rule =>
      own(async (call) => {
        if (delivered(call, "you")) return { text: "Merged, as you said." }
        if (asked(call, "Ask and work on")) {
          const name = [call, ...run.model.calls].map((one) => tool(one, "ask")).find(Boolean)
          if (!name) throw new Error("Novadeck's ask tool is missing")
          return {
            calls: [
              {
                name,
                input: {
                  subject: "Merge the branch?",
                  body: "It is ready.",
                  shape: {
                    type: "options",
                    options: [{ label: "Merge" }, { label: "Wait" }],
                    recommend: 0,
                  },
                },
              },
            ],
          }
        }
        if (result(call)?.includes(" is in the user's Inbox.")) {
          await finishing.opened
          return { text: "Worked on." }
        }
        return undefined
      })

    // Whether a request holds the person's pick as a user turn, typed by the doorbell.
    const lined = (call: Call): boolean =>
      call.turns.some(
        (entry) =>
          entry.role === "user" &&
          /\[Novadeck Inbox reply, ([A-Za-z0-9]+)\] Re your ask "Merge the branch\?": I picked "Merge"\. \[\1\]/.test(
            entry.text,
          ),
      )

    it("ends the turn the person's reply waits at, and the reply comes as its prompt", async ({
      e2e: run,
    }) => {
      const finishing = gate()
      run.model.use(asksAndWorksOn(run, finishing))
      const terminal = await start(run, setup)
      const calls = run.model.mark()
      await terminal.submit("Ask and work on")
      await run.model.waitFor(
        (call) => result(call)?.includes(" is in the user's Inbox.") === true,
        {
          after: calls,
        },
      )
      const ask = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
      // The turn runs on, its last reply held, as the person answers.
      run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 0, text: "" })
      finishing.open()
      await terminal.until("Merged, as you said.")
      // The first request to hold the reply has it as a user turn: no Stop gave it as context.
      const received = await run.model.waitFor((call) => !call.side && delivered(call, "you"), {
        after: calls,
      })
      expect(lined(received)).toBe(true)
    })

    // A reply near the line's limit fills more rows than a small pane's box has, for its head to
    // scroll away; the line is the prompt all the same, for auto mode to count it. Its first ring
    // lands it: a failed ring would leave the rescue of a line left in the box to do it.
    for (const rows of [14, 12])
      it(`rings a reply a box of ${rows} rows shows only the end of, and it comes as its prompt`, async ({
        e2e: run,
      }) => {
        const finishing = gate()
        finishing.open()
        run.model.use(
          asksAndWorksOn(run, finishing),
          own((call) => (delivered(call, "you") ? { text: "Merged, as you said." } : undefined)),
        )
        const terminal = await start(run, setup)
        await turn(terminal, "Ask and work on", "Worked on.")
        terminal.resize(40, rows)
        const calls = run.model.mark()
        const mark = terminal.mark()
        const ask = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
        const words = `Merge it${" and say so in the changelog".repeat(7)}, thanks.`
        run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 0, text: words })
        const received = await run.model.waitFor((call) => !call.side && delivered(call, "you"), {
          after: calls,
        })
        const typed = received.turns.find(
          (entry) => entry.role === "user" && entry.text.includes(words),
        )
        expect(typed?.text).toMatch(
          /\[Novadeck Inbox reply, ([A-Za-z0-9]+)\] Re your ask .* \[\1\]/,
        )
        const states = terminal
          .history()
          .slice(mark)
          .map((each) => each.delivery)
        expect(states).not.toContain("unknown")
      })

    // Words scrolled out of a short box over blank lines leave only blank rows to read, or on
    // Codex a dim arrow with the cursor back at the top: that's a draft, not an empty box, and no
    // ring may go out with it.
    for (const [lines, ups] of [
      [12, 0],
      [12, 4],
    ] as const)
      it(`rings nothing over a draft scrolled out of sight (${lines} blank lines, ${ups} Ups)`, async ({
        e2e: run,
      }) => {
        const finishing = gate()
        finishing.open()
        run.model.use(asksAndWorksOn(run, finishing))
        const terminal = await start(run, setup)
        await turn(terminal, "Ask and work on", "Worked on.")
        terminal.resize(40, 14)
        await sleep(1_200)
        const write = (data: string) =>
          run.deck.terminals.write({ terminalId: terminal.id, data }, "e2e")
        if (losesLineBreakKeys(setup))
          write(`\x1b[200~MY UNFINISHED DRAFT${"\n".repeat(lines)}\x1b[201~`)
        else {
          write("MY UNFINISHED DRAFT")
          await sleep(300)
          for (let line = 0; line < lines; line += 1) {
            write(setup.agent === "agy" ? "\x1b\r" : "\n")
            // eslint-disable-next-line no-await-in-loop -- One key after another.
            await sleep(120)
          }
        }
        for (let up = 0; up < ups; up += 1) {
          terminal.press("\x1b[A")
          // eslint-disable-next-line no-await-in-loop -- As above.
          await sleep(150)
        }
        await terminal.settled()
        // The words are out of sight, or the test is of nothing.
        expect(await terminal.screen()).not.toContain("MY UNFINISHED")
        const calls = run.model.mark()
        const ask = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
        run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 0, text: "Merge it." })
        await sleep(unrung * 3)
        expect(
          run.model.calls.slice(calls).some((call) => allOf(call).includes("MY UNFINISHED DRAFT")),
        ).toBe(false)
        // Nor does the chat's take of the box have them: they stay, in sight once scrolled to, a
        // key at a time, as Codex on Windows doesn't take them all in a burst, and no further
        // than the words, as an Up past them recalls history.
        expect((await run.deck.terminals.takeBox(terminal.id)).returned).toBeNull()
        for (let up = 0; up < lines + 4; up += 1) {
          // eslint-disable-next-line no-await-in-loop -- As above.
          if ((await terminal.screen()).includes("MY UNFINISHED")) break
          terminal.press("\x1b[A")
          // eslint-disable-next-line no-await-in-loop -- As above.
          await sleep(200)
        }
        await terminal.until("MY UNFINISHED")
      })

    // Words of other views' footers, each at a size where a real screen read it as that view
    // and the line stayed in the box (Claude Code 2.1.316, Codex 0.167.0, Antigravity 1.5.2,
    // e2e/probes/ring-reading.e2e.ts), on every harness: the footer is read under the box.
    for (const [words, columns, rows] of [
      ["Showing detailed transcript of it", 40, 12],
      ["enter to return · space to reply", 120, 24],
      ["Esc to cancel · ctrl+s to scope", 120, 24],
      ["reverse-i-search: merge", 40, 12],
      ["? / esc close", 80, 24],
      ["Keyboard: ctrl+k esc Close", 40, 12],
    ] as const)
      it(`rings a reply that says "${words}" at ${columns}x${rows}`, async ({ e2e: run }) => {
        const finishing = gate()
        finishing.open()
        run.model.use(asksAndWorksOn(run, finishing))
        const terminal = await start(run, setup)
        await turn(terminal, "Ask and work on", "Worked on.")
        terminal.resize(columns, rows)
        await sleep(1_200)
        const calls = run.model.mark()
        const ask = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
        // The words alone, no option picked: the line wraps as the probe's did, its words where
        // they were taken for the view.
        run.deck.terminals.answerAsk(ask.id, { type: "reply", option: null, text: words })
        const received = await run.model.waitFor((call) => !call.side && delivered(call, "you"), {
          after: calls,
        })
        expect(
          received.turns.some((entry) => entry.role === "user" && entry.text.includes(words)),
        ).toBe(true)
      })

    // A row of `─` in a reply read as the box's top rule, so as no box, on Claude Code and
    // Antigravity, at these sizes.
    for (const [columns, rows] of [
      [40, 14],
      [80, 12],
      [120, 24],
    ] as const)
      it(`rings a reply with a row of ─ in it at ${columns}x${rows}`, async ({ e2e: run }) => {
        const finishing = gate()
        finishing.open()
        run.model.use(asksAndWorksOn(run, finishing))
        const terminal = await start(run, setup)
        await turn(terminal, "Ask and work on", "Worked on.")
        terminal.resize(columns, rows)
        await sleep(1_200)
        const calls = run.model.mark()
        const ask = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
        const words = `see ${"─".repeat(Math.min(columns * 2, 160))} merge it`
        run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 0, text: words })
        const received = await run.model.waitFor((call) => !call.side && delivered(call, "you"), {
          after: calls,
        })
        expect(
          received.turns.some((entry) => entry.role === "user" && entry.text.includes(words)),
        ).toBe(true)
      })

    // Words a person or agent may write, here the footer of Claude Code's agents view: a reply
    // saying them is a line in the box like any other.
    it("rings a reply that says what a view's footer says", async ({ e2e: run }) => {
      const finishing = gate()
      finishing.open()
      run.model.use(
        asksAndWorksOn(run, finishing),
        own((call) => (delivered(call, "you") ? { text: "Merged, as you said." } : undefined)),
      )
      const terminal = await start(run, setup)
      await turn(terminal, "Ask and work on", "Worked on.")
      terminal.resize(170, 30)
      const calls = run.model.mark()
      const ask = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
      const words = "enter to open · then merge it"
      run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 0, text: words })
      await run.model.waitFor((call) => !call.side && delivered(call, "you"), { after: calls })
    })

    // Left opens Claude Code's agents view, whose field reads as a box in prompt mode and whose
    // Enter starts a session: with text in it, it reads as a view.
    it("takes Claude Code's agents view for a view at 14 rows, a paste in it", async ({
      e2e: run,
      skip,
    }) => {
      if (setup.agent !== "claude" || agentsViewOutlivesDeck(setup)) skip()
      run.model.use(replies("Warm up", "Warmed up."))
      const terminal = await start(run, setup)
      await turn(terminal, "Warm up", "Warmed up.")
      terminal.resize(40, 14)
      await sleep(1_200)
      const profile = harnesses[setup.agent].box!
      terminal.press("\x1b[D")
      await terminal.until("describe a task")
      terminal.press(`\x1b[200~${"and say so in the changelog ".repeat(6)}[n7Q2]\x1b[201~`)
      await terminal.until("[n7Q2]")
      await sleep(300)
      const shown = (await terminal.screenText())!
      expect(profile.overlay(shown), shown.rows.join("\n")).toBe(true)
    })

    it("gives the reply at the Stop over a draft of the person's, never typing beside it", async ({
      e2e: run,
    }) => {
      const finishing = gate()
      run.model.use(asksAndWorksOn(run, finishing))
      const terminal = await start(run, setup)
      const calls = run.model.mark()
      await terminal.submit("Ask and work on")
      await run.model.waitFor(
        (call) => result(call)?.includes(" is in the user's Inbox.") === true,
        {
          after: calls,
        },
      )
      const ask = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
      terminal.press("half a thought")
      await terminal.until("half a thought")
      run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 0, text: "" })
      finishing.open()
      await terminal.until("Merged, as you said.")
      const received = await run.model.waitFor((call) => !call.side && delivered(call, "you"), {
        after: calls,
      })
      expect(lined(received)).toBe(false)
      const shown = await terminal.screen()
      expect(shown).toContain("half a thought")
      expect(shown).not.toContain("[Novadeck")
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
          from: { kind: "person" },
          state: "delivered",
          text: "I signed in",
        }),
      )
    })

    it("drafts feedback on the agent's own, and again when the person asks, leaving it in the feedback card to settle", async ({
      e2e: run,
    }) => {
      // A tool is named as any terminal's request offers it: one may go out before its
      // MCP tools load.
      const named = (call: Call, name: string): string => {
        const found = [call, ...run.model.calls].map((one) => tool(one, name)).find(Boolean)
        if (!found) throw new Error(`Novadeck's ${name} tool is missing`)
        return found
      }
      let requested = false
      run.model.use(
        own((call) => {
          if (asked(call, "Hit a Novadeck bug"))
            return {
              calls: [
                {
                  name: named(call, "feedback"),
                  input: { kind: "bug", text: "The tell tool failed twice." },
                },
              ],
            }
          if (/feedback draft is in the user's feedback card/.test(result(call) ?? ""))
            return { text: requested ? "I drafted it again." : "I drafted the feedback." }
          if (delivered(call, "you")) {
            requested = true
            return {
              calls: [
                {
                  name: named(call, "feedback"),
                  input: { kind: "idea", text: "Show the hint I was given." },
                },
              ],
            }
          }
          return undefined
        }),
      )
      const terminal = await start(run, setup)
      await turn(terminal, "Hit a Novadeck bug", "I drafted the feedback.")
      // What the app's feedback.watch lists now.
      const drafts = async () => {
        const watch = run.deck.terminals.feedback.watch()
        const first = await watch.next()
        await watch.return(undefined)
        return first.value ?? []
      }
      expect(await drafts()).toMatchObject([
        { terminalId: terminal.id, handle: terminal.handle, kind: "bug", asked: false },
      ])
      const mark = terminal.mark()
      run.deck.terminals.feedback.ask(terminal.id, "the hint the person typed")
      await terminal.until("I drafted it again.")
      await through(terminal, ["settled"], { after: mark })
      const received = await run.model.waitFor((call) => !call.side && delivered(call, "you"))
      const text = [received.system, ...received.turns.map((entry) => entry.text)].join("\n")
      expect(text).toMatch(/person=['"][A-Za-z0-9]{8}['"]/)
      expect(text).toContain("the hint the person typed")
      expect(text).toContain("feedback tool")
      // The new draft replaced the first, and it answers the person's request.
      const [draft] = await drafts()
      expect(await drafts()).toMatchObject([
        { kind: "idea", text: "Show the hint I was given.", asked: true },
      ])
      run.deck.terminals.feedback.settle(draft!.id)
      expect(await drafts()).toEqual([])
    })
  })
}
