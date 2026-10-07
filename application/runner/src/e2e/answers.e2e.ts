import { copyFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { AgentDetail, RequestAnswer } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import type { Question } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { text, type Rule } from "./model/script.js"
import type { FakeModel } from "./model/server.js"
import { answers, lacking, own, result, start } from "./scenarios.js"

// Answering an agent's requests from the chat, through the dialog in its TUI, the same for
// every harness (see messaging.e2e.ts for the rule on parity): `agents.detail` shows each
// request's dialog as the harness's adapter read it from the screen, `agents.answer`
// presses its keys, and the model's next call says what the dialog took (docs/backend-api.md,
// "agents.answer").

type Dialog = NonNullable<AgentDetail["requests"][number]["dialog"]>
type Choices = Extract<Dialog, { type: "choices" }>
type Form = Extract<Dialog, { type: "form" }>
type Questions = Extract<Dialog, { type: "questions" }>

/**
 * Waits until the terminal's first request shows a dialog of `type`, and returns it with the
 * request's ref. A dialog of another type, as raw while the harness runs its hooks before it
 * draws, is waited past; one that stays fails the wait, saying what showed.
 */
const dialogOf = async (
  terminal: DeckTerminal,
  type: Dialog["type"],
): Promise<{ ref: string; dialog: Dialog }> => {
  let seen = "nothing"
  try {
    return await terminal.poll(
      async () => {
        const [request] = (await terminal.detail()).requests
        seen = JSON.stringify(request?.dialog ?? null).slice(0, 600)
        return request?.dialog?.type === type
          ? { ref: request.ref, dialog: request.dialog }
          : undefined
      },
      `its request to show a ${type} dialog`,
      60_000,
    )
  } catch (error) {
    throw new Error(`${String(error)}\nLast dialog seen: ${seen}`, { cause: error })
  }
}

/** The id of the dialog an answer names. */
const idOf = ({ dialog }: { dialog: Dialog }): string => (dialog.type === "raw" ? "raw" : dialog.id)

/** The dialog of `type`, or a failure showing what it was instead. */
const choices = ({ dialog }: { dialog: Dialog }): Choices => {
  if (dialog.type !== "choices") throw new Error(`Expected choices, got ${JSON.stringify(dialog)}`)
  return dialog
}
const questionsOf = ({ dialog }: { dialog: Dialog }): Questions => {
  if (dialog.type !== "questions")
    throw new Error(`Expected questions, got ${JSON.stringify(dialog)}`)
  return dialog
}

const formOf = ({ dialog }: { dialog: Dialog }): Form => {
  if (dialog.type !== "form") throw new Error(`Expected a form, got ${JSON.stringify(dialog)}`)
  return dialog
}

/** The option of the dialog whose label matches. */
const option = (dialog: Choices, label: RegExp, words: boolean | undefined = undefined) => {
  const found = dialog.options.find(
    (each) => label.test(each.label) && (words === undefined || (each.text !== null) === words),
  )
  if (!found) throw new Error(`No option ${label} in ${JSON.stringify(dialog)}`)
  return found
}

/** Waits until Novadeck lists no request waiting on the terminal's agent. */
const unrequested = (terminal: DeckTerminal) =>
  terminal.poll(
    async () => ((await terminal.detail()).requests.length === 0 ? true : undefined),
    "its request to be gone",
    30_000,
  )

/** The model's first call after `calls` whose latest tool result holds `words`. */
const resulting = (model: FakeModel, words: string, calls: number) =>
  model.waitFor((call) => result(call)?.includes(words) === true, { after: calls })

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
    { label: "Search", description: "Full text." },
  ],
}

/** The model's ending of a turn once a tool's result came. */
const noted: Rule = own((call) => (result(call) !== undefined ? { text: "Noted." } : undefined))

/** The dialog stub a scenario puts in a harness's place: it reads nothing. */
const stubbed = <T>(
  agent: "claude" | "codex" | "agy",
  dialogs: unknown,
  body: () => Promise<T>,
) => {
  const harness = harnesses[agent] as { dialogs?: unknown }
  const before = harness.dialogs
  harness.dialogs = dialogs
  return body().finally(() => {
    harness.dialogs = before
  })
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const { approval, asking, planning } = setup

    gated(it, lacking(setup, "approval"))(
      "answers a permission yes from the chat, and the tool runs",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Make the file", (call) => approval!.request(call)),
          noted,
        )
        const t1 = await start(run, setup)

        await t1.prompt("Make the file")
        const request = await dialogOf(t1, "choices")
        const yes = option(choices(request), /^Yes/, false)
        await t1.answer(request.ref, { dialog: idOf(request), type: "choice", option: yes.id })

        await t1.until("Noted.")
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "approval"))(
      "answers a permission no from the chat, which refuses the tool",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Make the file", (call) => approval!.request(call)),
          noted,
        )
        const t1 = await start(run, setup)

        await t1.prompt("Make the file")
        const request = await dialogOf(t1, "choices")
        const no = option(choices(request), /^No/)
        await t1.answer(request.ref, { dialog: idOf(request), type: "choice", option: no.id })

        await t1.until(approval!.denied)
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "approval"))(
      "answers a permission no with the person's words where its dialog takes them",
      async ({ e2e: run, skip }) => {
        run.model.use(
          answers("Make the file", (call) => approval!.request(call)),
          noted,
        )
        const t1 = await start(run, setup)
        const calls = run.model.mark()

        await t1.prompt("Make the file")
        const request = await dialogOf(t1, "choices")
        const dialog = choices(request)
        const telling = dialog.options.find(
          (each) => each.label.startsWith("No") && each.text !== null,
        )
        if (!telling) return skip(`${setup.name}'s permission dialog has no no that takes words`)
        const words = "Use a different file name"
        await t1.answer(request.ref, {
          dialog: idOf(request),
          type: "choice",
          option: telling.id,
          text: words,
        })

        // The model hears them, as the tool's refusal or as the person's next prompt.
        await run.model.waitFor((call) => text(call).includes(words), { after: calls })
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "approval"))(
      "keeps the person's keys out of the dialog it answers, and out of other terminals",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Make the file", (call) => approval!.request(call)),
          noted,
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        const calls = run.model.mark()

        await t1.prompt("Make the file")
        const request = await dialogOf(t1, "choices")
        const yes = option(choices(request), /^Yes/, false)
        // The person types in both while it goes on: the keys before its hold reach the
        // dialog, which takes none of them, and those during it are dropped.
        const typing = { on: true }
        const typist = (async () => {
          while (typing.on) {
            t1.press("z")
            // eslint-disable-next-line no-await-in-loop -- A key every so often.
            await sleep(15)
          }
        })()
        t2.press("elsewhere")
        await t1.answer(request.ref, { dialog: idOf(request), type: "choice", option: yes.id })
        typing.on = false
        await typist

        await t1.until("Noted.")
        await t2.until("elsewhere")
        expect(await t2.screen()).not.toContain("zz")
        // What the dialog took was the answer alone: no result of the model's holds their keys.
        await sleep(1000)
        expect(run.model.calls.slice(calls).filter((call) => result(call)?.includes("zz"))).toEqual(
          [],
        )
        // Typed while the answer held their keys, they were dropped, not replayed into
        // what came next; typed once it was done, they arrive.
        await sleep(500)
        t1.press("qq")
        await t1.until(/qq/)
      },
    )

    gated(it, lacking(setup, "approval"))(
      "falls back to the dialog's text, pressing nothing, where its adapter doesn't recognise it",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Make the file", (call) => approval!.request(call)),
          noted,
        )
        const t1 = await start(run, setup)
        const calls = run.model.mark()

        await stubbed(setup.agent, { read: () => undefined }, async () => {
          await t1.prompt("Make the file")
          // The screen is still, and nothing reads: raw, with what the terminal shows.
          const request = await dialogOf(t1, "raw")
          expect(request.dialog).toMatchObject({ type: "raw", reason: "unrecognized" })
          const shown = request.dialog.type === "raw" ? request.dialog.text : ""
          expect(shown).toMatch(approval!.shows)

          // Answering it presses nothing: the dialog stays as it was.
          await expect(
            t1.answer(request.ref, { dialog: idOf(request), type: "choice", option: "1" }),
          ).rejects.toMatchObject({ code: "CONFLICT" })
          await sleep(1000)
          expect(await t1.screen()).toMatch(approval!.shows)
          expect(run.model.calls.slice(calls).filter((call) => result(call) !== undefined)).toEqual(
            [],
          )
        })

        // The person answers it in the terminal, as ever.
        t1.press(approval!.deny)
        await t1.until(approval!.denied)
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "approval"))(
      "shows its dialog raw as unsupported where its harness has no adapter",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Make the file", (call) => approval!.request(call)),
          noted,
        )
        const t1 = await start(run, setup)

        await stubbed(setup.agent, undefined, async () => {
          await t1.prompt("Make the file")
          const request = await dialogOf(t1, "raw")
          expect(request.dialog).toMatchObject({ type: "raw", reason: "unsupported" })
          await expect(
            t1.answer(request.ref, { dialog: idOf(request), type: "choice", option: "1" }),
          ).rejects.toMatchObject({ code: "CONFLICT" })
          expect(await t1.screen()).toMatch(approval!.shows)
        })

        t1.press(approval!.deny)
        await t1.until(approval!.denied)
      },
    )

    gated(it, lacking(setup, "questions"))(
      "answers a question by option from the chat",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Ask me", (call) => asking!.questions(call, [colour])),
          noted,
        )
        const t1 = await start(run, setup)
        await asking!.enter?.(t1)
        const calls = run.model.mark()

        await t1.prompt("Ask me about the button")
        const request = await dialogOf(t1, "questions")
        const [question] = questionsOf(request).questions
        const green = question!.options.find(({ label }) => label === "Green")!
        await t1.answer(request.ref, {
          dialog: idOf(request),
          type: "questions",
          answers: [{ question: question!.id, options: [green.id] }],
        })

        const told = await resulting(run.model, "Green", calls)
        expect(result(told)).not.toContain("Blue")
        await t1.until("Noted.")
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "questions", "multiSelect"))(
      "answers a question with several options from the chat",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Ask me", (call) => asking!.questions(call, [features])),
          noted,
        )
        const t1 = await start(run, setup)
        await asking!.enter?.(t1)
        const calls = run.model.mark()

        await t1.prompt("Ask me about the features")
        const request = await dialogOf(t1, "questions")
        const [question] = questionsOf(request).questions
        expect(question!.multiSelect).toBe(true)
        const picked = question!.options
          .filter(({ label }) => label === "Auth" || label === "Search")
          .map(({ id }) => id)
        await t1.answer(request.ref, {
          dialog: idOf(request),
          type: "questions",
          answers: [{ question: question!.id, options: picked }],
        })

        const told = await resulting(run.model, "Auth", calls)
        expect(result(told)).toContain("Search")
        expect(result(told)).not.toContain("Billing")
        await t1.until("Noted.")
      },
    )

    gated(it, lacking(setup, "questions"))(
      "answers a question in the person's own words from the chat",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Ask me", (call) => asking!.questions(call, [colour])),
          noted,
        )
        const t1 = await start(run, setup)
        await asking!.enter?.(t1)
        const calls = run.model.mark()

        await t1.prompt("Ask me about the button")
        const request = await dialogOf(t1, "questions")
        const [question] = questionsOf(request).questions
        expect(question!.text).toBe(true)
        const words = "Purple with sparkles"
        const answer: RequestAnswer = {
          dialog: idOf(request),
          type: "questions",
          answers: [{ question: question!.id, options: [], text: words }],
        }
        await t1.answer(request.ref, answer)

        await resulting(run.model, words, calls)
        await t1.until("Noted.")
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "questions"))(
      "sets a question aside to talk it over from the chat",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Ask me", (call) => asking!.questions(call, [colour])),
          noted,
        )
        const t1 = await start(run, setup)
        await asking!.enter?.(t1)
        const calls = run.model.mark()

        await t1.prompt("Ask me about the button")
        const request = await dialogOf(t1, "questions")
        expect(questionsOf(request).chat).not.toBeNull()
        const words = "Before I choose, what do the colours cost?"
        await t1.answer(request.ref, { dialog: idOf(request), type: "chat", text: words })

        // The agent hears them, as the question's answer or as the person's next message.
        await run.model.waitFor((call) => text(call).includes(words), { after: calls })
        await unrequested(t1)
      },
    )

    gated(
      it,
      lacking(setup, "questions") ??
        (setup.agent === "agy" ? "its field takes the words with the answer" : undefined),
    )(
      "sets a question aside, then takes the next prompt from the chat's box",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Ask me", (call) => asking!.questions(call, [colour])),
          noted,
        )
        const t1 = await start(run, setup)
        await asking!.enter?.(t1)
        const calls = run.model.mark()

        await t1.prompt("Ask me about the button")
        const request = await dialogOf(t1, "questions")
        expect(questionsOf(request).chat).toBe("prompt")
        await t1.answer(request.ref, { dialog: idOf(request), type: "chat" })
        await unrequested(t1)

        // The chat's box sends the person's words on their own, as any prompt.
        const words = "Before I choose, what do the colours cost?"
        await t1.prompt(words)
        await run.model.waitFor((call) => text(call).includes(words), { after: calls })
      },
    )

    gated(it, lacking(setup, "plan"))("approves a plan from the chat", async ({ e2e: run }) => {
      planning!.seed?.(run.sandbox)
      run.model.use(...planning!.rules(run.sandbox, "Plan the button"))
      const t1 = await start(run, setup)
      await planning!.enter?.(t1)
      const calls = run.model.mark()

      await t1.prompt("Plan the button")
      const request = await dialogOf(t1, "choices")
      const dialog = choices(request)
      const approve = dialog.options.find(
        (each) => /^(Yes|Approve)/.test(each.label) && each.text === null,
      )
      if (!approve) throw new Error(`No approval in ${JSON.stringify(dialog)}`)
      await t1.answer(request.ref, { dialog: idOf(request), type: "choice", option: approve.id })

      await run.model.waitFor((call) => planning!.approved.test(text(call)), { after: calls })
      await unrequested(t1)
    })

    gated(it, lacking(setup, "plan"))(
      "rejects a plan with the person's feedback from the chat",
      async ({ e2e: run }) => {
        planning!.seed?.(run.sandbox)
        run.model.use(...planning!.rules(run.sandbox, "Plan the button"))
        const t1 = await start(run, setup)
        await planning!.enter?.(t1)
        const calls = run.model.mark()

        await t1.prompt("Plan the button")
        const request = await dialogOf(t1, "choices")
        const dialog = choices(request)
        const feedback = dialog.options.find((each) => each.text !== null)
        if (!feedback) throw new Error(`No option takes feedback in ${JSON.stringify(dialog)}`)
        const words = "Add a rollback step please"
        await t1.answer(request.ref, {
          dialog: idOf(request),
          type: "choice",
          option: feedback.id,
          text: words,
        })

        // The agent hears it, in the tool's result or as the person's next prompt, and the
        // plan wasn't approved.
        const heard = await run.model.waitFor((call) => text(call).includes(words), {
          after: calls,
        })
        expect(planning!.approved.test(text(heard))).toBe(false)
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "forms"))(
      "accepts a form an MCP server asks for, with the person's values",
      async ({ e2e: run }) => {
        const server = join(run.sandbox.root, "mcp-elicit-server.mjs")
        copyFileSync(join(import.meta.dirname, "mcp-elicit-server.mjs"), server)
        setup.forms!.prepare(run.sandbox, server)
        run.model.use(
          answers("Ask now", (call) => setup.forms!.ask(call)),
          noted,
        )
        const t1 = await start(run, setup)
        const calls = run.model.mark()

        await t1.prompt("Ask now")
        const request = await dialogOf(t1, "form")
        const form = formOf(request)
        expect(form.message).toContain("Tell us about yourself")
        const ids = Object.fromEntries(form.fields.map((field) => [field.label, field]))
        expect(ids.Name?.kind).toBe("text")
        expect(ids.Name?.required).toBe(true)
        expect(ids.Age?.kind).toBe("number")
        expect(ids.Subscribe?.kind).toBe("boolean")
        expect(ids.Color?.kind).toBe("choice")
        await t1.answer(request.ref, {
          dialog: idOf(request),
          type: "form",
          action: "accept",
          values: {
            [ids.Name!.id]: "Ada",
            [ids.Age!.id]: 36,
            [ids.Subscribe!.id]: true,
            [ids.Color!.id]: "Green",
          },
        })

        // What the server received is what the model read back.
        const told = await resulting(run.model, "elicited", calls)
        const got = result(told)!
        expect(got).toContain('"action":"accept"')
        expect(got).toContain('"name":"Ada"')
        expect(got).toContain('"age":36')
        expect(got).toContain('"subscribe":true')
        expect(got).toContain('"color":"Green"')
        await t1.until("Noted.")
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "forms"))(
      "declines a form an MCP server asks for",
      async ({ e2e: run }) => {
        const server = join(run.sandbox.root, "mcp-elicit-server.mjs")
        copyFileSync(join(import.meta.dirname, "mcp-elicit-server.mjs"), server)
        setup.forms!.prepare(run.sandbox, server)
        run.model.use(
          answers("Ask now", (call) => setup.forms!.ask(call)),
          noted,
        )
        const t1 = await start(run, setup)
        const calls = run.model.mark()

        await t1.prompt("Ask now")
        const request = await dialogOf(t1, "form")
        formOf(request)
        await t1.answer(request.ref, {
          dialog: idOf(request),
          type: "form",
          action: "decline",
          values: {},
        })

        const told = await resulting(run.model, "elicited", calls)
        expect(result(told)).toContain('"action":"decline"')
        await t1.until("Noted.")
        await unrequested(t1)
      },
    )

    gated(it, lacking(setup, "approval"))(
      "approves two identical queued commands from the chat in turn, each running once",
      async ({ e2e: run }) => {
        // The same call twice at once: the harness queues two identical dialogs.
        run.model.use(
          answers("Run it twice", (call) => {
            const [one] = approval!.request(call).calls ?? []
            return { calls: [one!, one!] }
          }),
          own((call) => {
            const results = call.turns.filter((turn) => turn.role === "tool")
            return results.length >= 2 ? { text: "Both ran." } : undefined
          }),
        )
        const t1 = await start(run, setup)
        await t1.prompt("Run it twice")

        const first = await dialogOf(t1, "choices")
        const yes = option(choices(first), /^Yes/, false)
        await t1.answer(first.ref, { dialog: idOf(first), type: "choice", option: yes.id })

        // The second one's dialog shows, for a request of its own or, where the harness
        // folds identical calls into one request, for the same.
        const second = await t1.poll(
          async () => {
            const [next] = (await t1.detail()).requests
            return next?.dialog?.type === "choices" && approval!.shows.test(await t1.screen())
              ? { ref: next.ref, dialog: next.dialog }
              : undefined
          },
          "the second request to show its dialog",
          60_000,
        )
        const again = option(choices(second), /^Yes/, false)
        await t1.answer(second.ref, { dialog: idOf(second), type: "choice", option: again.id })

        await t1.until("Both ran.")
        await unrequested(t1)
        // Each ran once: the model saw two results, no more.
        const last = run.model.calls.findLast((call) => !call.side)!
        expect(last.turns.filter((turn) => turn.role === "tool")).toHaveLength(2)
      },
    )
  })
}
