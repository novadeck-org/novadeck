import { handleWords } from "../terminals/handles.js"
import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { gate, latest, text, tool, type Call } from "./model/script.js"
import { closed, deliveries, delivered, holds, own, result, sends, start } from "./scenarios.js"

// A lead and its team across harnesses (docs/agent-messaging.md, "To its team", and
// docs/agent-workspace.md, "Closing terminals"): one `send` to `team` reaches a teammate
// in every harness, each as its lead's own message, and a teammate's report still on its
// way when its lead closes it arrives marked as from a closed terminal. Each harness
// leads in turn, so each one's tool schema carries `to` and each one reads the mark.
// Files ending in `.mixed.e2e.ts` run only when every harness is selected.

const team = [claude, codex, agy]
// The lead is moth, the first terminal; its teammates take the next handles, in order.
const mates = team.map((_, index) => handleWords[index + 1]!)

const brief = "Stand by for the team's rules."
const rule = "Don't re-run CI; tell me instead."
const report = "All green, ready to merge."

// The opening tag of each message the call's latest user turn carries, unescaped.
const wrappers = (call: Call): string[] => {
  const all = latest(call).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
  return [...all.matchAll(/<message\b[^>]*>/g)].map(([tag]) => tag)
}

// How many tool calls the agent made since the latest user turn holding `words`.
const callsSince = (call: Call, words: string): number => {
  const from = call.turns.findLastIndex((turn) => turn.role === "user" && turn.text.includes(words))
  return call.turns.slice(from + 1).filter((turn) => turn.role === "assistant" && turn.calls.length)
    .length
}

for (const lead of team)
  describe.skipIf(!supported)(
    `${lead.name} leading ${team.map(({ name }) => name).join(", ")}`,
    () => {
      const it = e2e(...team)

      // The lead opens one teammate per harness, each with the brief, one a call, and each
      // teammate answers its brief.
      const starting = () => [
        own((call) => {
          const open = tool(call, "open_agent")
          if (!open || !latest(call).includes("Start the team")) return undefined
          const made = callsSince(call, "Start the team")
          if (made < team.length)
            return { calls: [{ name: open, input: { agent: team[made]!.agent, message: brief } }] }
          return { text: "Team started." }
        }),
        own((call) =>
          delivered(call, "moth") && deliveries(call).some((one) => one.text === brief)
            ? { text: "Standing by." }
            : undefined,
        ),
      ]

      const opened = async (run: E2E) => {
        const requests = run.deck.answerRequests()
        const t1 = await start(run, lead)
        await t1.submit("Start the team")
        const terminals = []
        for (const _ of team)
          // eslint-disable-next-line no-await-in-loop -- Opened one a call, in order.
          terminals.push(await requests.next())
        expect(terminals.map(({ handle }) => handle)).toEqual(mates)
        await t1.until("Team started.")
        for (const terminal of terminals) {
          // eslint-disable-next-line no-await-in-loop -- Each answers its brief.
          await terminal.until("Standing by.")
          // eslint-disable-next-line no-await-in-loop -- As above.
          await terminal.reached("settled")
        }
        await t1.reached("settled")
        return { t1, terminals }
      }

      it("sends one message to its whole team, which reaches each harness as its lead's", async ({
        e2e: run,
      }) => {
        run.model.use(
          ...starting(),
          sends("Tell the team", "team", rule),
          own((call) => {
            const told = result(call)
            return told && latest(call).includes("Tell the team") && told.includes(" is queued")
              ? { text: "Told the team." }
              : undefined
          }),
          own((call) =>
            delivered(call, "moth") && deliveries(call).some((one) => one.text === rule)
              ? { text: "Noted the rule." }
              : undefined,
          ),
        )
        const { t1, terminals } = await opened(run)
        const calls = run.model.mark()

        await t1.submit("Tell the team")

        // One call, one line a teammate.
        const told = await run.model.waitFor(
          (call) => latest(call).includes("Tell the team") && result(call) !== undefined,
          { after: calls },
        )
        for (const handle of mates)
          expect(result(told)).toMatch(new RegExp(`Message m-[a-z0-9]+ to @${handle} is queued`))
        // Each teammate's model reads it, marked as its lead's.
        for (const [index, handle] of mates.entries()) {
          // eslint-disable-next-line no-await-in-loop -- Each teammate in turn.
          await terminals[index]!.until("Noted the rule.")
          // eslint-disable-next-line no-await-in-loop -- As above.
          await terminals[index]!.reached(holds("moth", handle, "delivered"))
        }
        const reads = run.model.calls
          .slice(calls)
          .filter(
            (call) => delivered(call, "moth") && deliveries(call).some((one) => one.text === rule),
          )
        expect(reads.length).toBeGreaterThanOrEqual(team.length)
        for (const call of reads)
          expect(wrappers(call).find((tag) => tag.includes('from="moth"'))).toMatch(
            / lead="[0-9A-Za-z]{8}"/,
          )
        await t1.until("Told the team.")
      })

      it("closes a teammate whose report is on its way, and the report arrives marked closed", async ({
        e2e: run,
      }) => {
        const reported = gate()
        const reporter = mates[team.indexOf(lead) === 0 ? 1 : 0]!
        run.model.use(
          ...starting(),
          own(async (call) => {
            const close = tool(call, "close_terminal")
            if (!close || !latest(call).includes("once it reports")) return undefined
            if (result(call) !== undefined) return undefined
            await reported.opened
            return { calls: [{ name: close, input: { to: reporter } }] }
          }),
          own((call) => (closed(call, reporter) ? { text: "Closed it." } : undefined)),
          sends("Report to moth", "moth", report),
          own((call) =>
            delivered(call, reporter) && deliveries(call).some((one) => one.text === report)
              ? { text: "Read its last report." }
              : undefined,
          ),
        )
        const { t1, terminals } = await opened(run)
        const sender = terminals[mates.indexOf(reporter)]!
        const calls = run.model.mark()
        const mark = t1.mark()

        // The lead's turn runs, its call held, while the teammate reports.
        await t1.submit(`Close ${reporter} once it reports`)
        await t1.reached("working", { after: mark })
        await sender.submit("Report to moth")
        await t1.reached(holds(reporter, "moth", "queued"), { after: mark })
        reported.open()

        const after = await run.model.waitFor((call) => closed(call, reporter), { after: calls })
        expect(result(after)).toMatch(
          /Its message m-[a-z0-9]+ \(sent \d\d:\d\d\) to you hadn't reached you yet: it still arrives, after this, marked as from a closed terminal/,
        )
        // At the end of the lead's turn, the report arrives, marked.
        const read = await run.model.waitFor(
          (call) => delivered(call, reporter) && text(call).includes(report),
          { after: calls },
        )
        expect(wrappers(read).find((tag) => tag.includes(`from="${reporter}"`))).toContain(
          ' closed="its terminal closed after sending this, so no reply reaches it"',
        )
        await t1.until("Read its last report.")
      })
    },
  )
