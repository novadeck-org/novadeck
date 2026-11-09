// PROBE, not a test of Novadeck: what Claude Code's auto mode check reads of the person's
// Inbox reply. Claude Code runs in auto mode against the fake model, whose judgement of an
// action says nothing, so this looks at what the check is given: the `<transcript>` of its
// request. A reply typed as the prompt must be there under `user`; one a Stop gave as
// context, as over a draft of the person's, must not. Claude Code only: no other harness
// sends such a request (Codex's reviewer was not probed). Runs only with
// NOVADECK_E2E_PROBES=1, by path.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "../agents/index.js"
import { describe, e2e, expect, supported, type E2E } from "../fixture.js"
import { asked, gate, tool, type Call } from "../model/script.js"
import { delivered, own, result } from "../scenarios.js"
import { probing } from "./support.js"

const setup = setups.find((each) => each.agent === "claude")!
const push = { name: "Bash", input: { command: "git push origin main", description: "Push" } }

// What the check's requests were given of the conversation, latest last.
const transcripts = (calls: readonly Call[]): string[] =>
  calls.flatMap((call) => {
    const text = call.side ? (call.turns.at(-1)?.text ?? "") : ""
    return text.includes("<transcript>") ? [text] : []
  })

describe.skipIf(!supported || !probing)(setup.name, () => {
  const it = e2e(setup)
  // The turn asks, works on until `finishing` opens, and, holding the reply, pushes.
  const scenario = async (run: E2E, draft: boolean) => {
    const path = join(run.sandbox.home, ".claude", "settings.json")
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      permissions: Record<string, unknown>
      env?: Record<string, string>
    }
    delete settings.permissions.disableAutoMode
    settings.permissions.defaultMode = "auto"
    // Since 2.1.319 the check runs on the server, in the Messages API's own answer, which a
    // gateway must pass through; the fake model gives none, and the session stops on "Auto
    // mode can't check actions in this session". This asks for the check the harness
    // runs itself, as 2.1.316 did, in a request of its own to the model.
    settings.env = { ...settings.env, CLAUDE_CODE_AUTO_MODE_SERVER: "0" }
    writeFileSync(path, JSON.stringify(settings))
    const finishing = gate()
    let pushed = false
    run.model.use(
      own(async (call) => {
        if (delivered(call, "you") && !pushed) {
          pushed = true
          return { calls: [push] }
        }
        if (delivered(call, "you")) return { text: "Done with it." }
        if (asked(call, "Warm up")) return { calls: [push] }
        if (asked(call, "Ask and work on")) {
          const name = [call, ...run.model.calls].map((one) => tool(one, "ask")).find(Boolean)
          return {
            calls: [
              {
                name: name!,
                input: {
                  subject: "Push it?",
                  body: "It is ready.",
                  shape: { type: "options", options: [{ label: "Push" }, { label: "Wait" }] },
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
      }),
    )
    const terminal = await run.deck.open(setup.agent)
    await terminal.reached("ready", { timeoutMs: 60_000 })
    // Its first check shows a notice about its billing through a gateway, once, up to 2.1.318
    // at least; 2.1.319 checks locally here and shows none.
    await terminal
      .confirm(/Enter to continue/, () => terminal.submit("Warm up"), { timeoutMs: 15_000 })
      .catch((error: unknown) => {
        if (!String(error).includes("Timed out")) throw error
      })
    await terminal.reached("settled", { timeoutMs: 30_000 })
    const calls = run.model.mark()
    const warmUp = transcripts(run.model.calls).length
    expect(warmUp).toBeGreaterThan(0)
    await terminal.submit("Ask and work on")
    await run.model.waitFor((call) => result(call)?.includes(" is in the user's Inbox.") === true, {
      after: calls,
    })
    const ask = run.deck.terminals.inboxEntries().find((each) => each.content.kind === "ask")!
    if (draft) {
      terminal.press("half a thought")
      await terminal.until("half a thought")
    }
    run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 0, text: "" })
    finishing.open()
    await terminal.until("Done with it.")
    // The check of the push the reply led to, never the warm-up's.
    const checks = transcripts(run.model.calls).slice(warmUp)
    const given = checks.at(-1)!
    // Two pushes: the warm-up's, and the one this check is of, after the reply.
    expect(given.match(/git push origin main/g)).toHaveLength(2)
    return given
  }

  it("is given a reply the doorbell typed as a user message", async ({ e2e: run }) => {
    const given = await scenario(run, false)
    expect(given).toMatch(/"user\\?":\\?"\[Novadeck Inbox reply, [^\]]*\] Re your ask/)
  })

  it("is not given a reply a Stop gave as context", async ({ e2e: run }) => {
    const given = await scenario(run, true)
    // The person's two prompts are all it holds of them: the ask is there as the agent's own.
    expect(given.match(/^\{"user":.*$/gm)).toEqual([
      '{"user":"Warm up"}',
      '{"user":"Ask and work on"}',
    ])
  })
})
