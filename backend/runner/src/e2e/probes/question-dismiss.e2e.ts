// PROBE, not a regression test: what dismissing a harness's question form does, against the
// chat's "talk it over" answer, to decide what the chat's Send should do while a question
// waits on the person. For each harness it asks one question (and two, a single-select
// then a multi-select), then either presses Escape in the TUI and
// sends the person's words once the request is gone, or answers `chat` with the words. It
// records, every 100 ms for a few seconds after the key: the requests Novadeck lists, the
// agent's activity and the screen's last rows; and every model call after the key: whether
// the turn went on (a call before the words), what the tool's result said, and the call that
// carried the words. One JSON file per case in QUESTION_PROBE_OUT (default
// <tmp>/question-dismiss-probe).
// Run: NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=claude,codex,agy pnpm --filter \
//   @novadeck/runner exec vitest run --config vitest.e2e.config.ts \
//   src/e2e/probes/question-dismiss.e2e.ts
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentDetail, RequestAnswer } from "@novadeck/protocol"

import type { Question } from "../agents/agent.js"
import { setups } from "../agents/index.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, expect, gated, supported } from "../fixture.js"
import { text, type Call } from "../model/script.js"
import type { FakeModel } from "../model/server.js"
import { answers, lacking, own, result, start } from "../scenarios.js"
import { sleep } from "./support.js"

const out = process.env.QUESTION_PROBE_OUT ?? join(tmpdir(), "question-dismiss-probe")
mkdirSync(out, { recursive: true })

type Dialog = NonNullable<AgentDetail["requests"][number]["dialog"]>

const colour: Question = {
  question: "Which color should the button be?",
  header: "Color",
  multiSelect: false,
  options: [
    { label: "Blue", description: "The house color." },
    { label: "Green", description: "Calmer." },
  ],
}
const features: Question = {
  question: "Which features should be enabled?",
  header: "Features",
  multiSelect: true,
  options: [
    { label: "Auth", description: "Login." },
    { label: "Billing", description: "Payments." },
  ],
}
const words = "Forget the button, tell me about the footer instead."

/** A call, short: its last turns, as the model saw them. */
const brief = (call: Call) => ({
  side: call.side,
  last: call.turns
    .slice(-3)
    .map((turn) =>
      turn.role === "assistant"
        ? { role: turn.role, text: turn.text, calls: turn.calls.map(({ name }) => name) }
        : { role: turn.role, text: turn.text.slice(0, 1500) },
    ),
})

const dialogOf = (terminal: DeckTerminal) =>
  terminal.poll(
    async () => {
      const [request] = (await terminal.detail()).requests
      return request?.dialog?.type === "questions"
        ? { ref: request.ref, dialog: request.dialog as Extract<Dialog, { type: "questions" }> }
        : undefined
    },
    "its question's dialog",
    60_000,
  )

/** Every 100 ms for `ms`: Novadeck's requests, the activity and the screen's last rows. */
const watch = async (terminal: DeckTerminal, since: number, ms: number) => {
  const seen: unknown[] = []
  let last = ""
  while (Date.now() - since < ms) {
    // eslint-disable-next-line no-await-in-loop -- Looked at in turn.
    const detail = await terminal.detail()
    // eslint-disable-next-line no-await-in-loop -- As above.
    const screen = await terminal.screen()
    const tail = screen
      .split("\n")
      .filter((row) => row.trim() !== "")
      .slice(-8)
      .join("\n")
    const state = {
      requests: detail.requests.map((r) => r.dialog?.type ?? null),
      activity: terminal.summary().activity?.state ?? null,
      tail: tail === last ? "(same)" : tail,
    }
    last = tail
    seen.push({ at: Date.now() - since, ...state })
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(100)
  }
  return seen
}

const calls = (model: FakeModel, after: number) =>
  model.calls.slice(after).map((call) => ({ ...brief(call), words: text(call).includes(words) }))

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const { asking } = setup

    const ask = (questions: readonly Question[]) => (run: { readonly model: FakeModel }) =>
      run.model.use(
        answers(words, () => ({ text: "Heard you." })),
        answers("Ask me", (call) => asking!.questions(call, questions)),
        own((call) => (result(call) !== undefined ? { text: "Noted." } : undefined)),
      )

    for (const [shape, questions] of [
      ["one", [colour]],
      ["two", [colour, features]],
    ] as const) {
      gated(it, lacking(setup, "questions"))(
        `${shape}: Escape, then the words as a prompt`,
        async ({ e2e: run }) => {
          ask(questions)(run)
          const t1 = await start(run, setup)
          await asking!.enter?.(t1)
          await t1.prompt("Ask me about the button")
          const { dialog } = await dialogOf(t1)
          const mark = run.model.mark()
          const since = Date.now()
          t1.press("\x1b")
          const timeline = await watch(t1, since, 6000)
          const before = calls(run.model, mark)
          let prompted: unknown
          try {
            await t1.prompt(words)
            prompted = "sent"
          } catch (error) {
            prompted = { error: String(error) }
          }
          let heard: unknown = null
          try {
            heard = brief(
              await run.model.waitFor((call) => text(call).includes(words), {
                after: mark,
                timeoutMs: 20_000,
              }),
            )
            await t1.until("Heard you.", 20_000)
          } catch (error) {
            heard = { error: String(error) }
          }
          await sleep(1500)
          const record = {
            harness: setup.name,
            shape,
            path: "escape",
            dialog,
            timeline,
            callsBeforeWords: before,
            prompted,
            heard,
            allCalls: calls(run.model, mark),
            screen: await t1.screen(),
          }
          writeFileSync(
            join(out, `${setup.name}-${shape}-escape.json`),
            JSON.stringify(record, null, 2),
          )
          expect(record.timeline.length).toBeGreaterThan(0)
        },
      )

      gated(it, lacking(setup, "questions"))(
        `${shape}: Escape, then the words at once`,
        async ({ e2e: run }) => {
          ask(questions)(run)
          const t1 = await start(run, setup)
          await asking!.enter?.(t1)
          await t1.prompt("Ask me about the button")
          await dialogOf(t1)
          const mark = run.model.mark()
          t1.press("\x1b")
          const attempts: unknown[] = []
          const since = Date.now()
          let sent = false
          while (!sent && Date.now() - since < 8000) {
            try {
              // eslint-disable-next-line no-await-in-loop -- Tried in turn.
              await t1.prompt(words)
              sent = true
              attempts.push({ at: Date.now() - since, sent: true })
            } catch (error) {
              attempts.push({ at: Date.now() - since, error: String(error).slice(0, 200) })
              // eslint-disable-next-line no-await-in-loop -- As above.
              await sleep(50)
            }
          }
          let heard: unknown = null
          try {
            heard = brief(
              await run.model.waitFor((call) => text(call).includes(words), {
                after: mark,
                timeoutMs: 20_000,
              }),
            )
          } catch (error) {
            heard = { error: String(error) }
          }
          await sleep(2000)
          writeFileSync(
            join(out, `${setup.name}-${shape}-escape-at-once.json`),
            JSON.stringify(
              {
                harness: setup.name,
                shape,
                path: "escape-at-once",
                attempts,
                heard,
                allCalls: calls(run.model, mark),
                screen: await t1.screen(),
              },
              null,
              2,
            ),
          )
          expect(attempts.length).toBeGreaterThan(0)
        },
      )

      gated(it, lacking(setup, "questions"))(
        `${shape}: talk it over (chat answer) with the words`,
        async ({ e2e: run }) => {
          ask(questions)(run)
          const t1 = await start(run, setup)
          await asking!.enter?.(t1)
          await t1.prompt("Ask me about the button")
          const request = await dialogOf(t1)
          const mark = run.model.mark()
          const since = Date.now()
          let answered: unknown
          if (request.dialog.chat === null) answered = "no chat on this dialog"
          else {
            const answer: RequestAnswer = { dialog: request.dialog.id, type: "chat", text: words }
            try {
              await t1.answer(request.ref, answer)
              answered = { took: Date.now() - since }
            } catch (error) {
              answered = { error: String(error), after: Date.now() - since }
            }
          }
          const timeline = await watch(t1, since, 4000)
          let heard: unknown = null
          if (request.dialog.chat !== null)
            try {
              heard = brief(
                await run.model.waitFor((call) => text(call).includes(words), {
                  after: mark,
                  timeoutMs: 20_000,
                }),
              )
            } catch (error) {
              heard = { error: String(error) }
            }
          await sleep(2000)
          writeFileSync(
            join(out, `${setup.name}-${shape}-chat.json`),
            JSON.stringify(
              {
                harness: setup.name,
                shape,
                path: "chat",
                dialog: request.dialog,
                answered,
                timeline,
                heard,
                allCalls: calls(run.model, mark),
                screen: await t1.screen(),
              },
              null,
              2,
            ),
          )
          expect(timeline.length).toBeGreaterThan(0)
        },
      )
    }
  })
}
