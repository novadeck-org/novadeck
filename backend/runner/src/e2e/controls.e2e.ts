import { basename, isAbsolute, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { Harness } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import type { FolderQuestion } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { racesOwnSettings } from "./known-gaps.js"
import { asked, gate, latest, Refusal, tool, type Call, type Reply } from "./model/script.js"
import {
  answers,
  deliveries,
  delivered,
  holds,
  lacking,
  messages,
  nestedRuns,
  own,
  prompted,
  result,
  replies,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
  unrung,
} from "./scenarios.js"

// The person's controls over a running agent, and seeds that leave something untrusted,
// the same for every harness (see messaging.e2e.ts for the rule on parity): what each
// harness needs for them is a trait of its setup, and one without it skips, saying which.
// The states asserted are docs/agent-messaging.md's ("What counts", "States").

// The tool the agent called last, whose answer the call may be its look at.
const calledLast = (call: Call): string | undefined =>
  call.turns.findLast((each) => each.role === "assistant")?.calls.at(-1)?.name

// How long a terminal is watched for what a held reply, once let go, would show.
const quiet = 3000

// What the nested run a background command starts is asked, which only its own
// conversation holds as a user's words.
const { leftRunning } = nestedRuns

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
  { select, trusts, probe }: FolderQuestion,
): Promise<void> => {
  if (select === "") return
  // A key that takes shows the TUI reads, which the Enter that follows needs.
  if (probe) {
    const moved = () =>
      terminal.until(probe.moved, 1000).then(
        () => true,
        () => false,
      )
    for (let tries = 0; tries < 20; tries += 1) {
      terminal.press(probe.away)
      // eslint-disable-next-line no-await-in-loop -- Each look waits on the key before.
      if (await moved()) break
    }
  }
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

/**
 * Leaves a review screen with its `skip` keys, pressed again while it shows: a TUI may
 * draw it before it reads keys, dropping one pressed then.
 */
const leave = async (
  terminal: DeckTerminal,
  { shows, skip }: { readonly shows: RegExp; readonly skip: string },
): Promise<void> => {
  for (let tries = 0; tries < 10; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each look waits on the key before.
    await terminal.escape(skip)
    // eslint-disable-next-line no-await-in-loop -- As above.
    if (!shows.test(await terminal.screen())) return
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(steady)
    // A late redraw may have left it since: another key would land on the prompt.
    // eslint-disable-next-line no-await-in-loop -- As above.
    if (!shows.test(await terminal.screen())) return
  }
  throw new Error(`${terminal.handle} still shows ${String(shows)} after ${skip} pressed 10 times`)
}

// The refusal each harness's API gives a plan out of quota: Claude Code's subscription
// limit (without a retry, as it would otherwise wait out its backoff), Codex's
// `usage_limit_reached`, and the quota error Antigravity's backend answers.
const limitRefusal = (agent: AgentName): Refusal =>
  agent === "claude"
    ? new Refusal(
        429,
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "This request would exceed your usage limit.",
          },
        },
        { "x-should-retry": "false", "anthropic-ratelimit-unified-status": "rejected" },
      )
    : agent === "codex"
      ? new Refusal(429, {
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            plan_type: "plus",
            resets_in_seconds: 3600,
          },
        })
      : new Refusal(429, {
          error: {
            code: 429,
            message:
              "You have exhausted your capacity on this model. Your quota will reset after 59m30s.",
            status: "RESOURCE_EXHAUSTED",
            // Antigravity retries by the delay it names, for minutes if it is long.
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "QUOTA_EXHAUSTED",
                domain: "cloudcode-pa.googleapis.com",
                metadata: { model: "gemini-3.1-pro", quotaResetDelay: "59m30s" },
              },
              { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" },
            ],
          },
        })

// A reply that has the agent write `path` with its harness's own tool.
const writing = (agent: AgentName, path: string): Reply =>
  agent === "claude"
    ? { calls: [{ name: "Write", input: { file_path: path, content: "x\n" } }] }
    : agent === "codex"
      ? {
          // The fake model's Codex is offered no apply_patch tool of its own (0.159.3), but
          // runs the program through its shell, which Codex takes as the same patch.
          calls: [
            {
              name: "exec_command",
              input: {
                cmd: `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch\nEOF`,
                yield_time_ms: 5000,
              },
            },
          ],
        }
      : {
          calls: [
            {
              name: "write_to_file",
              input: {
                TargetFile: path,
                Overwrite: true,
                CodeContent: "x\n",
                Description: "Writes the file",
                toolSummary: "Write",
                toolAction: "Writing",
              },
            },
          ],
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

        // Enter answers the question only once it shows, and Novadeck sees it waiting on
        // the person.
        await t1.confirm(approval!.shows, async () => {
          await t1.submit("Make the file")
          await t1.poll(
            async () => ((await t1.detail()).requests.length > 0 ? true : undefined),
            "Novadeck to see the tool's request",
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
          "Novadeck to see the tool's request",
        )
        const calls = run.model.mark()
        // Pressed into the dialog once drawn whole, which may drop a key before.
        await t1.settled()
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
      if (setup.running) await t1.until(setup.running)
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
        sends("Ask moth for news", "moth", "Any news?"),
        own((call) => (sent(call, "moth") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "fox") ? { text: "No news." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      expect([t1.handle, t2.handle]).toEqual(["moth", "fox"])
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
      await t2.submit("Ask moth for news")
      await through(t1, ["ringing", "working", holds("fox", "moth", "delivered")], {
        after: settled.index,
      })
      await t1.until("No news.")
    })

    // The work a turn leaves running, which wakes the agent once done: a subagent, or a
    // command its shell tool runs in the background, a nested run of the harness whose
    // model call the test holds. Its end wakes the agent, whose turn then settles.
    for (const work of ["subagent", "command"] as const) {
      const traits =
        work === "subagent" ? (["background"] as const) : (["background.command", "shell"] as const)
      gated(it, lacking(setup, ...traits))(
        work === "subagent"
          ? "stays Working while a subagent it left running runs past its turn, and settles once it ends"
          : "shows a command it left running without working on, and settles again once it ends",
        async ({ e2e: run }) => {
          const finishing = gate()
          const owns =
            work === "subagent"
              ? background!.owns
              : (call: Call) =>
                  !call.side &&
                  call.turns.some((one) => one.role === "user" && one.text.includes(leftRunning))
          run.model.use(
            own(async (call) => {
              if (!owns(call)) return undefined
              await finishing.opened
              return { text: "Background work done." }
            }),
            answers("Start the work", (call) =>
              work === "subagent"
                ? background!.start(call)
                : background!.command!(call, setup.shell!.nested(leftRunning)),
            ),
            own((call) =>
              result(call) !== undefined && !owns(call) ? { text: "Started the work." } : undefined,
            ),
          )
          const t1 = await start(run, setup)
          const calls = run.model.mark()
          const mark = t1.mark()

          await t1.submit("Start the work")
          await run.model.waitFor(owns, { after: calls })
          await t1.reached("working", { after: mark })
          await t1.until("Started the work.")
          if (work === "subagent") {
            // Its turn ends while the subagent runs: the agent works on, waiting on it, as
            // its terminal shows and delivery holds it. Antigravity's Stop says only that
            // something runs; its status line counts it.
            await t1.poll(
              () => (t1.summary().activity?.background?.agents === 1 ? true : undefined),
              "the agent's turn to end, its subagent counted",
            )
            expect(t1.summary().activity?.state).toBe("working")
            expect(t1.history().at(-1)?.delivery).toBe("working")
            // Still so a moment on, past any status line drawn after the Stop.
            await sleep(quiet)
            expect(t1.summary().activity).toMatchObject({ state: "working" })
            expect(
              t1
                .history()
                .slice(mark)
                .map((one) => one.delivery),
            ).not.toContain("settled")
          } else {
            // Its turn ends while the command runs, which may run for ever, as a dev server
            // does: it shows as left running, but the agent is idle, and Settled.
            const left = await t1.poll(() => {
              const activity = t1.summary().activity
              return activity?.state === "idle" ? (activity.background ?? undefined) : undefined
            }, "the agent idle, its command still running")
            expect(left.agents).toBe(0)
            await t1.reached("settled", { after: mark })
            await sleep(quiet)
            expect(t1.summary().activity).toMatchObject({ state: "idle", background: left })
          }

          // The work ends and wakes the agent, whose turn then settles, with nothing running.
          const woken = run.model.mark()
          const before = t1.mark()
          finishing.open()
          await run.model.waitFor((call) => !call.side && !owns(call), { after: woken })
          await t1.reached("settled", { after: before })
          await t1.poll(
            () =>
              t1.summary().activity?.state === "idle" && t1.summary().activity?.background === null
                ? true
                : undefined,
            "the agent idle, nothing left running",
          )
        },
      )
    }

    // Its box takes a prompt while a subagent its turn left running runs (#325): a message
    // sent then rings it at its empty box, and is delivered once, the subagent still held.
    gated(it, lacking(setup, "background"))(
      "rings it while a subagent it left running runs, delivering once",
      async ({ e2e: run }) => {
        const finishing = gate()
        const { owns } = background!
        run.model.use(
          own(async (call) => {
            if (!owns(call)) return undefined
            await finishing.opened
            return { text: "Background work done." }
          }),
          answers("Start the work", (call) => background!.start(call)),
          sends("Ask moth for news", "moth", "Any news?"),
          own((call) => (sent(call, "moth") ? { text: "Asked." } : undefined)),
          own((call) => (delivered(call, "fox") ? { text: "No news." } : undefined)),
          own((call) =>
            result(call) !== undefined && !owns(call) ? { text: "Started the work." } : undefined,
          ),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        expect([t1.handle, t2.handle]).toEqual(["moth", "fox"])
        const calls = run.model.mark()
        const mark = t1.mark()

        // Its turn ends while the subagent runs, its call held.
        await t1.submit("Start the work")
        await run.model.waitFor(owns, { after: calls })
        await t1.until("Started the work.")
        await t1.poll(
          () => (t1.summary().activity?.background?.agents === 1 ? true : undefined),
          "the agent's turn to end, its subagent counted",
        )
        const stopped = t1.mark()

        // fox's message rings it, and its doorbell prompt's hook delivers it.
        await t2.submit("Ask moth for news")
        await t2.until("Asked.")
        const rung = await run.model.waitFor((call) => delivered(call, "fox"), { after: calls })
        expect(latest(rung)).toMatch(ring)
        expect(deliveries(rung)).toEqual([{ from: "fox", text: "Any news?" }])
        await t1.until("No news.")
        await through(t1, ["ringing", "working", holds("fox", "moth", "delivered")], {
          after: stopped,
        })
        // All the while, the subagent's call is held: it still runs, counted once the ring's
        // turn has ended (Antigravity's Stop says only that something runs, its status line
        // counts it).
        await t1.poll(
          () => (t1.summary().activity?.background?.agents === 1 ? true : undefined),
          "the subagent still counted after the ring's turn",
        )

        // It ends and wakes the agent, whose turn settles with nothing left: one delivery.
        const woken = run.model.mark()
        const before = t1.mark()
        finishing.open()
        await run.model.waitFor((call) => !call.side && !owns(call), { after: woken })
        await t1.reached("settled", { after: before })
        await t1.poll(
          () =>
            t1.summary().activity?.state === "idle" && t1.summary().activity?.background === null
              ? true
              : undefined,
          "the agent idle, nothing left running",
        )
        expect(run.model.calls.slice(calls).filter((call) => delivered(call, "fox"))).toHaveLength(
          1,
        )
        expect(messages(t1).map((one) => one.state)).toEqual(["delivered"])
        expect(
          t1
            .history()
            .slice(mark)
            .map((one) => one.delivery),
        ).not.toContain("unknown")
      },
    )

    it("tells the start of the agent's last reply once its turn ends", async ({ e2e: run }) => {
      // Claude Code's and Codex's Stop name the reply; Antigravity's transcript records it.
      run.model.use(
        replies("Sum it up", "## Summary\n\nPlover-7 finished: **all green**, nothing left."),
      )
      const t1 = await start(run, setup)
      const mark = t1.mark()

      await t1.submit("Sum it up")
      await t1.reached("working", { after: mark })
      await t1.poll(() => (t1.summary().activity?.lastTurn ? true : undefined), "the turn to end")
      expect(t1.summary().activity).toMatchObject({
        state: "idle",
        lastTurn: {
          outcome: "completed",
          reply: "Summary Plover-7 finished: all green, nothing left.",
        },
      })
    })

    it("reads the agent's last reply from its own records when its Stop names none", async ({
      e2e: run,
    }) => {
      // As Claude Code's StopFailure, or a Stop whose reply the hook dropped: the runner
      // reads the session's transcript or rollout instead. Antigravity's Stop never names one.
      const harness = harnesses[setup.agent] as { decode: Harness["decode"] }
      const { decode } = harness
      harness.decode = (report) => {
        if (report.event !== "Stop") return decode(report)
        const { last_assistant_message: _dropped, ...payload } = report.payload
        return decode({ ...report, payload })
      }
      try {
        run.model.use(replies("Sum it up", "Plover-9 finished: nothing left."))
        const t1 = await start(run, setup)
        const mark = t1.mark()

        await t1.submit("Sum it up")
        await t1.reached("working", { after: mark })
        await t1.poll(() => (t1.summary().activity?.lastTurn ? true : undefined), "the turn to end")
        expect(t1.summary().activity?.lastTurn).toMatchObject({
          outcome: "completed",
          reply: "Plover-9 finished: nothing left.",
        })
      } finally {
        harness.decode = decode
      }
    })

    it("reads the agent's final words, not those before a tool call, when its Stop names none", async ({
      e2e: run,
    }) => {
      // The final words land in the records a moment after the Stop hook starts, so a read
      // then finds only the words before the turn's tool call, which aren't its reply.
      const harness = harnesses[setup.agent] as { decode: Harness["decode"] }
      const { decode } = harness
      harness.decode = (report) => {
        if (report.event !== "Stop") return decode(report)
        const { last_assistant_message: _dropped, ...payload } = report.payload
        return decode({ ...report, payload })
      }
      try {
        run.model.use(
          own((call) => {
            const agents = tool(call, "agents")
            if (agents && asked(call, "Look around"))
              return { text: "Plover-5 is looking first.", calls: [{ name: agents, input: {} }] }
            if (result(call) !== undefined) return { text: "Plover-5 found nothing new." }
            return undefined
          }),
        )
        const t1 = await start(run, setup)
        const mark = t1.mark()

        await t1.submit("Look around")
        await t1.reached("working", { after: mark })
        await t1.poll(() => (t1.summary().activity?.lastTurn ? true : undefined), "the turn to end")
        expect(t1.summary().activity?.lastTurn).toMatchObject({
          outcome: "completed",
          reply: "Plover-5 found nothing new.",
        })
      } finally {
        harness.decode = decode
      }
    })

    it("ends a turn whose Stop hook's report never came, as its own records tell", async ({
      e2e: run,
    }) => {
      // As when Novadeck's hook failed to run: the turn ends all the same, from Claude Code's
      // transcript, Codex's rollout, or Antigravity's idle status line.
      const harness = harnesses[setup.agent] as { decode: Harness["decode"] }
      const { decode } = harness
      harness.decode = (report) => (report.event === "Stop" ? [] : decode(report))
      try {
        run.model.use(replies("Say the word", "Plover-3 says hello."))
        const t1 = await start(run, setup)
        const mark = t1.mark()

        await t1.submit("Say the word")
        await t1.reached("working", { after: mark })
        await t1.until("Plover-3 says hello.")
        await t1.poll(
          () => (t1.summary().activity?.state === "idle" ? true : undefined),
          "the turn to end",
        )
        // Delivery takes it as over too: Settled where the records say it completed,
        // Unknown where only an idle status line says it ended. Its step follows the
        // activity's within the same report, which a slow runner can take a while over.
        await t1.poll(
          () => (t1.history().at(-1)?.delivery !== "working" ? true : undefined),
          "delivery to take the turn as over",
          5_000,
        )
      } finally {
        harness.decode = decode
      }
    })

    it("ends a turn its model refused, and settles", async ({ e2e: run }) => {
      // An API rejecting the request fails the turn: Claude Code's StopFailure and
      // Antigravity's Stop say so; Codex fires no hook, and its rollout records the failed
      // turn's end (see docs/harness-coverage.md, "Activity").
      run.model.use(
        own((call) => {
          if (!call.side && asked(call, "Refuse this")) throw new Refusal(400)
          return undefined
        }),
      )
      const t1 = await start(run, setup)
      const mark = t1.mark()

      await t1.submit("Refuse this")
      await t1.reached("working", { after: mark })
      await t1.poll(
        () => (t1.summary().activity?.state === "idle" ? true : undefined),
        "the failed turn to end",
        60_000,
      )
      // Delivery's step follows the activity's within the same report, which a slow runner
      // can take a while over (seen on macOS CI: 7 ms apart in a 346 ms report).
      await t1.poll(
        () => (t1.history().at(-1)?.delivery !== "working" ? true : undefined),
        "delivery to take the failed turn as over",
        5_000,
      )
      // The turn says why it failed, in its harness's words: the API's refusal.
      const lastTurn = t1.summary().activity?.lastTurn
      expect(lastTurn).toMatchObject({ outcome: "failed", limit: null })
      expect(lastTurn?.error).toMatch(/400|refused/)
    })

    it("ends a turn its model refused on a usage limit, and says why", async ({ e2e: run }) => {
      // The refusal each API gives a spent plan: a 429 its harness takes as a limit and,
      // without a window of the account's own to name (only Codex's rate-limit headers can
      // be faked), carries as the turn's error alone.
      run.model.use(
        own((call) => {
          if (!call.side && asked(call, "Hit the limit")) throw limitRefusal(setup.agent)
          return undefined
        }),
      )
      const t1 = await start(run, setup)
      const mark = t1.mark()

      await t1.submit("Hit the limit")
      await t1.reached("working", { after: mark })
      const lastTurn = await t1.poll(
        () => {
          const last = t1.summary().activity?.lastTurn
          return t1.summary().activity?.state === "idle" ? last : undefined
        },
        "the failed turn to end",
        60_000,
      )
      expect(lastTurn).toMatchObject({ outcome: "failed" })
      expect(lastTurn?.error).toMatch(/limit|429|exhausted|quota/i)
    })

    it("names the files a turn wrote", async ({ e2e: run }) => {
      const file = join(run.sandbox.project, "wrote.txt")
      const second = join(run.sandbox.project, "again.txt")
      run.model.use(
        own(async (call) => {
          const done = call.turns.filter((each) => each.role === "tool").length
          if (!asked(call, "Write them") && done === 0) return undefined
          if (done === 0) return writing(setup.agent, file)
          if (done === 1) return writing(setup.agent, second)
          // Codex's rollout, which names a patch its shell ran, is read a moment behind
          // its hooks: the turn runs on a little past its last write, as a real one does.
          await sleep(3000)
          return { text: "Wrote them." }
        }),
      )
      const t1 = await start(run, setup)
      const mark = t1.mark()

      await t1.submit("Write them")
      await t1.reached("working", { after: mark })
      // Its tools may ask the person before writing (Claude Code and Antigravity by default,
      // Codex where its sandbox fails, one patch after another): the chat allows each
      // through the dialog the adapter read, the oldest not yet answered first (an answered
      // one waits for its hook or its rollout to settle it, as the Inbox shows it answering).
      await t1.poll(
        async () => {
          const request = (await t1.detail()).requests.find((each) => !each.answered)
          const { dialog } = request ?? {}
          const yes = dialog?.type === "choices" ? dialog.options[0] : undefined
          if (request && dialog?.type === "choices" && yes && yes.label.startsWith("Yes"))
            await t1.answer(request.ref, { dialog: dialog.id, type: "choice", option: yes.id })
          return t1.summary().activity?.lastTurn?.outcome === "completed" ? true : undefined
        },
        "the turn to end",
        90_000,
      )
      // Every permission asked is settled: a write Codex ran through its shell fires no hook,
      // so its rollout's word on the file does (a request left pending would head the Inbox).
      await t1.poll(
        async () => ((await t1.detail()).requests.length === 0 ? true : undefined),
        "the writes' requests to be settled",
        10_000,
      )
      const files = t1.summary().activity?.lastTurn?.files
      expect(files?.map((one) => basename(one))).toEqual(["wrote.txt", "again.txt"])
      expect(files?.every((one) => isAbsolute(one))).toBe(true)
    })
  })

  describe.skipIf(!supported)(`${setup.name}, its hooks untrusted`, () => {
    const it = e2e.seeded({ hooksTrusted: false }, setup)
    const hooks = setup.trust?.hooks

    gated(it, lacking(setup, "trust.hooks"))(
      "binds no session, yet sends, told replies can't reach it, and can't be sent to",
      async ({ e2e: run }) => {
        // t1's agent lists the terminals until Novadeck has found t2's hooks untrusted, which
        // it asks once t2's prompt shows past its review, and only then sends: a send while
        // t2's review is still open waits, as the person may yet trust its hooks there.
        let looks = 0
        run.model.use(
          own(async (call) => {
            const agents = tool(call, "agents")
            const send = tool(call, "send")
            if (!agents || !send) return undefined
            if (asked(call, "Tell fox hello")) return { calls: [{ name: agents, input: {} }] }
            const listing = result(call)
            if (calledLast(call) !== agents || listing === undefined) return undefined
            if (/- @?fox: no agent Novadeck can deliver to: .*\/hooks/.test(listing))
              return { calls: [{ name: send, input: { to: "fox", text: "Hello." } }] }
            looks += 1
            if (looks > 60) return { text: "Gave up." }
            await sleep(500)
            return { calls: [{ name: agents, input: {} }] }
          }),
          own((call) => (result(call) !== undefined ? { text: "Tried." } : undefined)),
        )
        const t1 = await run.deck.open(setup.agent)
        const t2 = await run.deck.open(setup.agent)
        // The person leaves each review without trusting Novadeck's hooks. Escape may skip
        // it, so the keys go as `escape` sends them, apart from what is typed next.
        for (const one of [t1, t2]) {
          // eslint-disable-next-line no-await-in-loop -- One review at a time.
          await one.until(hooks!.shows, 60_000)
          // eslint-disable-next-line no-await-in-loop -- As above.
          await leave(one, hooks!)
        }
        await prompted(t1, setup)
        const calls = run.model.mark()

        await t1.submit("Tell fox hello")

        // One send, both ways: t2 has no agent Novadeck can deliver to, and t1 is told that
        // replies can't reach it.
        const answer = await run.model.waitFor(
          (call) =>
            !call.side && result(call) !== undefined && calledLast(call) === tool(call, "send"),
          { after: calls, timeoutMs: 60_000 },
        )
        const said = result(answer) ?? ""
        expect(said).not.toMatch(/is queued/)
        expect(said).toMatch(/no agent Novadeck can deliver to: .*\/hooks/)
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
          sends("Tell fox hello", "fox", "Hello."),
          own((call) => (result(call) !== undefined ? { text: "Told fox." } : undefined)),
          own((call) => (delivered(call, "moth") ? { text: "Hello to you." } : undefined)),
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
        // Known gap (known-gaps.ts, `racesOwnSettings`): there the second starts once the
        // first asks, as two starting together may race on the harness's own settings.
        if (racesOwnSettings(setup)) await t1.until(shows, 60_000)
        const t2 = await run.deck.open(setup.agent)
        expect([t1.handle, t2.handle]).toEqual(["moth", "fox"])
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
            await t1.submit("Tell fox hello")
            // The send was taken, so t2 holds the message: one its harness refused (as
            // Antigravity does a call missing what it asks of it) fails here, saying why.
            const sending = await run.model.waitFor(
              (call) =>
                !call.side && result(call) !== undefined && calledLast(call) === tool(call, "send"),
              { after: calls },
            )
            expect(result(sending)).toMatch(/to @?fox is queued/)
            await t1.until("Told fox.")
            await t1.reached("settled", { after: from1 })
            await t2.reached(holds("moth", "fox", "queued"))
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
        await through(t2, ["ready", "ringing", "working", holds("moth", "fox", "delivered")], {
          timeoutMs: 60_000,
        })
        const rung = await run.model.waitFor((call) => delivered(call, "moth"), {
          after: calls,
        })
        expect(latest(rung)).toMatch(ring)
        await t2.until("Hello to you.")
      },
    )
  })
}
