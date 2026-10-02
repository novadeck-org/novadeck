import { setTimeout as sleep } from "node:timers/promises"

import type { FolderQuestion } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { asked, gate, latest, tool, type Call } from "./model/script.js"
import {
  answers,
  delivered,
  holds,
  lacking,
  messages,
  own,
  prompted,
  replies,
  result,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
} from "./scenarios.js"

// The person's controls over a running agent, and seeds that leave something untrusted,
// the same for every harness (see messaging.e2e.ts for the rule on parity): what each
// harness needs for them is a trait of its setup, and one without it skips, saying which.
// The states asserted are docs/agent-messaging.md's ("What counts", "States").

// The tool the agent called last, whose answer the call may be its look at.
const calledLast = (call: Call): string | undefined =>
  call.turns.findLast((each) => each.role === "assistant")?.calls.at(-1)?.name

// How long a terminal is watched for a ring that mustn't come: past the doorbell's settle
// window (6 s from when a terminal shows Ready), so a ring had every chance to start.
const unrung = 8000

// How long a terminal is watched for what a held reply, once let go, would show.
const quiet = 3000

// How long the option trusting the folder must stay selected before Enter answers the
// question: Claude Code 2.1.287 draws its question again about 130 ms after the first,
// with "No, exit" selected anew, undoing a key pressed in between (seen in the sandbox).
const steady = 1000

/**
 * Selects the folder question's option that trusts the folder, pressing its `select` keys
 * until the screen shows it selected and still does `steady` later: a TUI may draw the
 * question a moment before it reads keys, dropping one pressed then, or draw it again,
 * resetting what was selected. A question showing it selected needs no key.
 */
const choose = async (
  terminal: DeckTerminal,
  { select, trusts }: FolderQuestion,
): Promise<void> => {
  if (select === "") return
  for (let tries = 0; tries < 10; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each look waits on the one before.
    if (trusts.test(await terminal.screen())) {
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(steady)
      // eslint-disable-next-line no-await-in-loop -- As above.
      if (trusts.test(await terminal.screen())) return
      continue
    }
    terminal.press(select)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await terminal.until(trusts, 1000).catch(() => undefined)
  }
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const { approval, background } = setup

    gated(it, lacking(setup, "approval"))(
      "asks before a tool runs, and runs it once the person allows it",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Make the file", (call) => approval!.request(call)),
          own((call) => (result(call) !== undefined ? { text: "Made it." } : undefined)),
        )
        const t1 = await start(run, setup)
        const calls = run.model.mark()
        const mark = t1.mark()

        // Enter answers the question only once it shows, and NovaDeck sees it waiting on
        // the person.
        await t1.confirm(approval!.shows, async () => {
          await t1.submit("Make the file")
          await t1.poll(
            async () => ((await t1.detail()).requests.length > 0 ? true : undefined),
            "NovaDeck to see the tool's request",
          )
        })

        // The tool ran: the model reads its result, and the turn ends normally.
        await run.model.waitFor((call) => !call.side && result(call) !== undefined, {
          after: calls,
        })
        await t1.until("Made it.")
        await through(t1, ["working", "settled"], { after: mark })
        expect((await t1.detail()).requests).toEqual([])
        expect(
          t1
            .history()
            .slice(mark)
            .map((one) => one.delivery),
        ).not.toContain("unknown")
      },
    )

    gated(it, lacking(setup, "approval"))(
      "ends the turn without a normal Stop when the person refuses the tool",
      async ({ e2e: run }) => {
        run.model.use(
          answers("Make the file", (call) => approval!.request(call)),
          own((call) => (result(call) !== undefined ? { text: "Made it anyway." } : undefined)),
        )
        const t1 = await start(run, setup)
        const mark = t1.mark()

        await t1.submit("Make the file")
        await t1.until(approval!.shows)
        await t1.poll(
          async () => ((await t1.detail()).requests.length > 0 ? true : undefined),
          "NovaDeck to see the tool's request",
        )
        const calls = run.model.mark()
        t1.press(approval!.deny)

        // A denial is an abnormal end: Unknown, never Settled, and its request resolved.
        await t1.reached("unknown", { after: mark })
        await t1.poll(
          async () => ((await t1.detail()).requests.length === 0 ? true : undefined),
          "the refused request to resolve",
        )
        // The harness refused it, as the keys alone can't show: it says so, and the tool's
        // result never reaches the model.
        await t1.until(approval!.denied)
        await sleep(quiet)
        expect(run.model.calls.slice(calls).filter((call) => result(call) !== undefined)).toEqual(
          [],
        )
        expect(
          t1
            .history()
            .slice(mark)
            .map((one) => one.delivery),
        ).not.toContain("settled")
      },
    )

    it("ends a turn interrupted by Escape without a normal Stop, and takes the next prompt", async ({
      e2e: run,
    }) => {
      // The first prompt's reply is held, so Escape comes mid-turn, the model call open.
      const held = gate()
      const answered = gate()
      run.model.use(
        replies("Carry on", "Carried on."),
        own(async (call) => {
          if (!call.turns.some((one) => one.role === "user" && one.text.includes("Take your time")))
            return undefined
          await held.opened
          answered.open()
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Take your time")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Take your time"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await t1.escape()

      const ended = await t1.reached("unknown", { after: mark })
      held.open()
      // The harness interrupted the turn, as the key alone can't show: it says so, and the
      // held reply, once given, never shows nor ends the turn.
      await answered.opened
      await t1.until(setup.interrupted("Take your time"))
      await sleep(quiet)
      expect(await t1.screen()).not.toContain("Too late.")
      expect(
        t1
          .history()
          .slice(mark)
          .map((one) => one.delivery),
      ).not.toContain("settled")

      // The next prompt starts a turn that ends normally.
      await turn(t1, "Carry on", "Carried on.")
      expect(
        t1
          .history()
          .slice(ended.index)
          .map((one) => one.delivery),
      ).toContain("settled")
    })

    it("takes a bare Enter on its empty box mid-turn as nothing, and is rung after the turn", async ({
      e2e: run,
    }) => {
      // The reply is held, so the Enter comes mid-turn, the box known empty since the
      // prompt was submitted.
      const held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Held on." }
        }),
        sends("Ask t1 for news", "t1", "Any news?"),
        own((call) => (sent(call, "t1") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "t2") ? { text: "No news." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      expect([t1.handle, t2.handle]).toEqual(["t1", "t2"])
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Hold on")
      await run.model.waitFor((call) => !call.side && asked(call, "Hold on"), { after: calls })
      await t1.reached("working", { after: mark })
      t1.enterEmpty()
      held.open()

      // It submitted nothing and left no draft: the turn ends Settled, and no other turn
      // starts.
      await t1.until("Held on.")
      const settled = await t1.reached("settled", { after: mark })
      const states = t1
        .history()
        .slice(mark, settled.index + 1)
        .map((one) => one.delivery)
      const turned = states.slice(states.indexOf("working"), -1)
      expect(turned.length > 0 && turned.every((one) => one === "working")).toBe(true)
      expect(
        run.model.calls.slice(calls).filter((call) => !call.side && !asked(call, "Hold on")),
      ).toEqual([])

      // A message for it now rings it, as for any Settled terminal.
      await t2.submit("Ask t1 for news")
      await through(t1, ["ringing", "working", holds("t2", "t1", "delivered")], {
        after: settled.index,
      })
      await t1.until("No news.")
    })

    gated(it, lacking(setup, "background"))(
      "stays Working while its background work runs past its turn, and settles once it ends",
      async ({ e2e: run }) => {
        const finishing = gate()
        run.model.use(
          own(async (call) => {
            if (!background!.owns(call)) return undefined
            await finishing.opened
            return { text: "Background work done." }
          }),
          answers("Start the work", (call) => background!.start(call)),
          own((call) => (result(call) !== undefined ? { text: "Started the work." } : undefined)),
        )
        const t1 = await start(run, setup)
        const calls = run.model.mark()
        const mark = t1.mark()

        await t1.submit("Start the work")
        await run.model.waitFor(background!.owns, { after: calls })
        await t1.reached("working", { after: mark })
        await t1.until("Started the work.")
        // Its turn ends while the work runs: the agent idles, but something it started
        // still runs, so NovaDeck holds it Working.
        await t1.poll(
          async () => ((await t1.detail()).activity?.state === "idle" ? true : undefined),
          "the agent's turn to end",
        )
        expect(t1.history().at(-1)?.delivery).toBe("working")
        expect(
          t1
            .history()
            .slice(mark)
            .map((one) => one.delivery),
        ).not.toContain("settled")

        // The work ends and wakes the agent, whose turn then settles.
        const woken = run.model.mark()
        finishing.open()
        await run.model.waitFor((call) => !call.side && !background!.owns(call), {
          after: woken,
        })
        await t1.reached("settled", { after: mark })
      },
    )
  })

  describe.skipIf(!supported)(`${setup.name}, its hooks untrusted`, () => {
    const it = e2e.seeded({ hooksTrusted: false }, setup)
    const hooks = setup.trust?.hooks

    gated(it, lacking(setup, "trust.hooks"))(
      "binds no session, yet sends, told replies can't reach it, and can't be sent to",
      async ({ e2e: run }) => {
        // t1's agent lists the terminals until NovaDeck has found t2's hooks untrusted, which
        // it asks once t2's prompt shows past its review, and only then sends: a send while
        // t2's review is still open waits, as the person may yet trust its hooks there.
        let looks = 0
        run.model.use(
          own(async (call) => {
            const agents = tool(call, "agents")
            const send = tool(call, "send")
            if (!agents || !send) return undefined
            if (asked(call, "Tell t2 hello")) return { calls: [{ name: agents, input: {} }] }
            const listing = result(call)
            if (calledLast(call) !== agents || listing === undefined) return undefined
            if (/- t2: no agent NovaDeck can deliver to: .*\/hooks/.test(listing))
              return { calls: [{ name: send, input: { to: "t2", text: "Hello." } }] }
            looks += 1
            if (looks > 60) return { text: "Gave up." }
            await sleep(500)
            return { calls: [{ name: agents, input: {} }] }
          }),
          own((call) => (result(call) !== undefined ? { text: "Tried." } : undefined)),
        )
        const t1 = await run.deck.open(setup.agent)
        const t2 = await run.deck.open(setup.agent)
        // The person leaves each review without trusting NovaDeck's hooks. Escape may skip
        // it, so the keys go as `escape` sends them, apart from what is typed next.
        for (const one of [t1, t2]) {
          // eslint-disable-next-line no-await-in-loop -- One review at a time.
          await one.until(hooks!.shows, 60_000)
          // eslint-disable-next-line no-await-in-loop -- As above.
          await one.escape(hooks!.skip)
        }
        await prompted(t1, setup)
        const calls = run.model.mark()

        await t1.submit("Tell t2 hello")

        // One send, both ways: t2 has no agent NovaDeck can deliver to, and t1 is told that
        // replies can't reach it.
        const answer = await run.model.waitFor(
          (call) =>
            !call.side && result(call) !== undefined && calledLast(call) === tool(call, "send"),
          { after: calls, timeoutMs: 60_000 },
        )
        const said = result(answer) ?? ""
        expect(said).not.toMatch(/is queued/)
        expect(said).toMatch(/no agent NovaDeck can deliver to: .*\/hooks/)
        expect(said).toMatch(/replies can't reach you/)
        await t1.until("Tried.")
        expect(messages(t1)).toEqual([])
        expect(messages(t2)).toEqual([])
        // Neither ever bound a session, so neither shows an agent.
        for (const one of [t1, t2]) {
          expect(one.history().map((snapshot) => snapshot.delivery)).toEqual(
            one.history().map(() => "unbound"),
          )
          expect(one.summary().agent).toBeNull()
        }
      },
    )
  })

  describe.skipIf(!supported)(`${setup.name}, its folder untrusted`, () => {
    const it = e2e.seeded({ folderTrusted: false }, setup)
    const question = setup.trust?.folder

    gated(it, lacking(setup, "trust.folder"))(
      "never rings an agent at its folder-trust question, and rings it once trusted",
      async ({ e2e: run }) => {
        const { shows, trusts } = question!
        run.model.use(
          sends("Tell t2 hello", "t2", "Hello."),
          own((call) => (result(call) !== undefined ? { text: "Told t2." } : undefined)),
          own((call) => (delivered(call, "t1") ? { text: "Hello to you." } : undefined)),
        )
        // Both ask before either is trusted, as trusting the folder in one covers the other.
        // Each `confirm` starts before its question can show, so the question it waits
        // for is one drawn after it began, whether or not trusting is selected at first.
        const t1 = await run.deck.open(setup.agent)
        const asking = gate()
        const trusting = t1.confirm(trusts, async () => {
          await t1.until(shows, 60_000)
          await asking.opened
          await choose(t1, question!)
        })
        trusting.catch(() => {})
        const t2 = await run.deck.open(setup.agent)
        expect([t1.handle, t2.handle]).toEqual(["t1", "t2"])
        const calls = run.model.mark()

        // The person trusts the folder in t1, and t1 sends t2 a message. While t2's
        // question shows, the message waits and never rings it. Then the person trusts
        // the folder there too.
        await t2.confirm(
          trusts,
          async () => {
            await t2.until(shows, 60_000)
            asking.open()
            await trusting
            await t1.reached("ready", { timeoutMs: 60_000 })
            await prompted(t1, setup)
            const from1 = t1.mark()
            await t1.submit("Tell t2 hello")
            await t1.until("Told t2.")
            await t1.reached("settled", { after: from1 })
            await t2.reached(holds("t1", "t2", "queued"))
            await new Promise((resolve) => setTimeout(resolve, unrung))
            const states = t2.history().map((one) => one.delivery)
            expect(states).not.toContain("ready")
            expect(states).not.toContain("ringing")
            expect(messages(t2).map((one) => one.state)).toEqual(["queued"])
            await t2.until(shows)
            await choose(t2, question!)
          },
          { timeoutMs: 5000 },
        )

        // Trusted, its prompt shows: Ready, rung, and its hook delivers the message.
        await through(t2, ["ready", "ringing", "working", holds("t1", "t2", "delivered")], {
          timeoutMs: 60_000,
        })
        const rung = await run.model.waitFor((call) => delivered(call, "t1"), {
          after: calls,
        })
        expect(latest(rung)).toMatch(ring)
        await t2.until("Hello to you.")
      },
    )
  })
}
