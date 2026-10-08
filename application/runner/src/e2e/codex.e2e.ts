import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, latest, type Call } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  messages,
  own,
  replies,
  result,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
  unrung,
} from "./scenarios.js"

// What only Codex needs beyond the shared scenarios (messaging.e2e.ts).

const it = e2e(codex)

/** Ten rows in a row holding braille, as Codex draws its logo. */
const logo = /(?:^.*[⠀-⣿].*\n){10}/m

// What its footer says while it shows a `/side` conversation: its keys are spelled out in
// 0.159.3 (ctrl+/) and abbreviated in 0.161.0 (^/).
const side = /Side from main thread · (?:ctrl\+|\^)\/ to switch · (?:ctrl\+|\^)c to close/

// How long a terminal is watched for a binding that mustn't change once a turn is done.
const quiet = 3000

// What its approval dialog says of the thread asking, for a spawned agent's (0.159.3).
const thread = (agentId: string) => new RegExp(`Thread: Agent \\(${agentId.slice(0, 8)}\\)`)

/** Whether the call is of the spawned agent's own conversation, which its task began. */
const helper = (call: Call): boolean =>
  call.turns.some((one) => one.role === "user" && one.text.includes("Helper task"))

/**
 * The records of a spawned agent's own rollout, which Codex files beside its root's under
 * the agent's id (`rollout-<time>-<agent id>.jsonl`), as Novadeck follows it.
 */
const rollout = (
  home: string,
  agentId: string,
): readonly { type?: string; payload?: { type?: string } }[] => {
  const sessions = join(home, ".codex", "sessions")
  const files = readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((one) =>
    one.endsWith(`-${agentId}.jsonl`),
  )
  expect(files).toHaveLength(1)
  return readFileSync(join(sessions, files[0]!), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type?: string; payload?: { type?: string } })
}

describe.skipIf(!supported)("Codex", () => {
  // Wide and tall enough, Codex draws a logo on its first screen while its box is empty,
  // and erases it as anything lands there: the doorbell's test paste changes rows far
  // from its line, which it accepts only as text vanishing whole (docs/agent-messaging.md,
  // "The doorbell").
  it("rings a Codex still at its first screen", async ({ e2e: run }) => {
    run.model.use(
      sends("Ask t2 for the code word", "t2", "What is the code word?"),
      own((call) => (sent(call, "t2") ? { text: "Asked." } : undefined)),
      own((call) => (delivered(call, "t1") ? { text: "Heron." } : undefined)),
    )
    const t1 = await start(run, codex)
    const t2 = await start(run, codex)
    // The case this covers: the logo shows as t2 is rung.
    await t2.until(logo)
    const calls = run.model.mark()
    const mark = t2.mark()

    await t1.submit("Ask t2 for the code word")

    await through(t2, ["ringing", "working"], { after: mark })
    const rung = await run.model.waitFor((call) => delivered(call, "t1"), { after: calls })
    expect(latest(rung)).toMatch(ring)
    expect(deliveries(rung)).toEqual([{ from: "t1", text: "What is the code word?" }])
    await t2.until("Heron.")
    await through(t2, [holds("t1", "t2", "delivered"), "settled"], { after: mark })
    expect(messages(t2).map((one) => one.state)).toEqual(["delivered"])
  })

  // `/side` forks an ephemeral thread, which Codex shows in place of the root's, its title
  // naming it, though it takes no writer lock; the person asks it something on the side,
  // then goes back to the root. Its hooks name no transcript (docs/agent-messaging.md,
  // "Per harness"). The person's keys opening it leave the terminal Drafting, so nothing
  // rings the side conversation's box, and their next prompt in the root delivers.
  it("keeps its session bound through a /side conversation, and delivers at the root's next prompt", async ({
    e2e: run,
  }) => {
    run.model.use(
      replies("Remember the word heron", "Remembered."),
      replies("Ask on the side", "Answered on the side."),
      own((call) =>
        asked(call, "Back at the root") ? { text: "Back, with t2's news." } : undefined,
      ),
      sends("Tell t1 the news", "t1", "The build is green."),
      own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
    )
    const t1 = await start(run, codex)
    await turn(t1, "Remember the word heron", "Remembered.")
    const root = (await t1.detail()).sessionId
    expect(root).not.toBeNull()
    const t2 = await start(run, codex)
    const calls = run.model.mark()
    const mark = t1.mark()

    // The person opens a side conversation: its title names the fork, which no new lock
    // confirms, so the root stays bound past the title's check.
    await t1.submit("/side")
    await t1.until(side)
    await t2.submit("Tell t1 the news")
    await t2.until("Told t1.")
    await t1.reached(holds("t2", "t1", "queued"), { after: mark })
    await sleep(unrung)
    expect((await t1.detail()).sessionId).toBe(root)
    // Their keys left it Drafting: the message waits, never rung into the side box.
    const viewing = t1
      .history()
      .slice(mark)
      .map((one) => one.delivery)
    expect(viewing).toContain("drafting")
    expect(viewing).not.toContain("ringing")
    expect(viewing).not.toContain("unbound")
    expect(run.model.calls.slice(calls).filter((call) => latest(call).match(ring))).toEqual([])

    // The side conversation's first prompt starts its own session, which says `fork`: the
    // root stays bound, and its hooks get nothing.
    await t1.submit("Ask on the side")
    const aside = await run.model.waitFor((call) => !call.side && asked(call, "Ask on the side"), {
      after: calls,
    })
    expect(deliveries(aside)).toEqual([])
    await t1.until("Answered on the side.")
    await sleep(quiet)
    expect((await t1.detail()).sessionId).toBe(root)
    expect(t1.summary().agent).toBe("codex")
    expect(messages(t1).map((one) => one.state)).toEqual(["queued"])

    // Back at the root, the person's next prompt carries the message.
    t1.press("\x03")
    await t1.poll(
      async () => (side.test(await t1.screen()) ? undefined : true),
      "the side conversation to close",
    )
    await t1.submit("Back at the root")
    const back = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
    expect(asked(back, "Back at the root")).toBe(true)
    expect(deliveries(back)).toEqual([{ from: "t2", text: "The build is green." }])
    // In the root's own conversation, which never held the side question.
    expect(
      back.turns.some((one) => one.role === "user" && one.text.includes("Remember the word heron")),
    ).toBe(true)
    expect(
      back.turns.some((one) => one.role === "user" && one.text.includes("Ask on the side")),
    ).toBe(false)
    await t1.until("Back, with t2's news.")
    await through(t1, [holds("t2", "t1", "delivered"), "settled"], { after: mark })
    expect((await t1.detail()).sessionId).toBe(root)
  })
  // A spawned agent's approval dialog shows in its root's screen, naming its thread. Esc on
  // it fires no hook (no Interrupt, no SubagentStop) and aborts only that agent's turn,
  // which only its own rollout records, `turn_aborted`; Novadeck follows that rollout while
  // the request waits (docs/agent-messaging.md, "What counts"). The root's turn has ended,
  // so nothing else would ever say the dialog is gone.
  it("never rings while a spawned agent's request waits, and rings once its rollout records Esc on it", async ({
    e2e: run,
  }) => {
    run.model.use(
      own((call) => {
        const spawn = call.tools.find((offered) => offered.endsWith("spawn_agent"))
        if (!spawn || !asked(call, "Spawn a helper")) return undefined
        return { calls: [{ name: spawn, input: { message: "Helper task: echo outside" } }] }
      }),
      own((call) => (result(call)?.includes('"agent_id"') ? { text: "Spawned it." } : undefined)),
      own((call) => (asked(call, "Helper task") ? codex.approval!.request(call) : undefined)),
      sends("Tell t1 the news", "t1", "The build is green."),
      own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
      own((call) => (delivered(call, "t2") ? { text: "Noted the news." } : undefined)),
    )
    const t1 = await start(run, codex)
    const t2 = await start(run, codex)
    const calls = run.model.mark()
    const mark = t1.mark()

    // The root spawns an agent and its turn ends; the agent's command asks, its dialog in
    // the root's screen, and Novadeck sees the request waiting.
    await turn(t1, "Spawn a helper", "Spawned it.")
    const spawned = await run.model.waitFor(
      (call) => !call.side && result(call)?.includes('"agent_id"') === true,
      { after: calls },
    )
    const agentId = (JSON.parse(result(spawned)!) as { agent_id: string }).agent_id
    await t1.until(codex.approval!.shows)
    await t1.until(thread(agentId))
    const waiting = await t1.poll(async () => {
      const detail = await t1.detail()
      return detail.requests.length > 0 ? detail : undefined
    }, "Novadeck to see the spawned agent's request")
    expect(waiting.requests).toHaveLength(1)
    expect(waiting.activity?.attention?.pending).toBe(1)
    const asking = waiting.requests[0]!.actor
    expect(waiting.actors.find((one) => one.ref === asking)?.role).toBe("subagent")
    expect(waiting.activity?.subagents.map((one) => one.id)).toEqual([asking])

    // t2's message waits for it, past the doorbell's settle window: t1 is never rung.
    await t2.submit("Tell t1 the news")
    await t2.until("Told t1.")
    const queued = await t1.reached(holds("t2", "t1", "queued"), { after: mark })
    await sleep(unrung)
    expect(
      t1
        .history()
        .slice(queued.index)
        .map((one) => one.delivery),
    ).not.toContain("ringing")
    expect(messages(t1).map((one) => one.state)).toEqual(["queued"])
    expect((await t1.detail()).requests).toHaveLength(1)
    expect(run.model.calls.slice(calls).filter((call) => latest(call).match(ring))).toEqual([])
    await t1.until(thread(agentId))

    // The person presses Esc on the dialog, never Enter: Codex aborts the agent's turn,
    // which its own rollout records, the dialog gone from the screen.
    const pressed = t1.mark()
    await t1.escape()
    const after = await t1.poll(async () => {
      const detail = await t1.detail()
      return detail.requests.length === 0 ? detail : undefined
    }, "Novadeck to take the spawned agent's request as settled")
    expect(after.activity?.attention?.pending ?? 0).toBe(0)
    // Its turn aborted, its thread open: it still runs.
    expect(after.activity?.subagents.map((one) => one.id)).toEqual([asking])
    expect(thread(agentId).test(await t1.screen())).toBe(false)
    const records = rollout(run.sandbox.home, agentId)
    expect(
      records.some((one) => one.type === "event_msg" && one.payload?.type === "turn_aborted"),
    ).toBe(true)

    // Then t1 is rung, and its hook delivers.
    const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
    expect(latest(rung)).toMatch(ring)
    expect(deliveries(rung)).toEqual([{ from: "t2", text: "The build is green." }])
    await t1.until("Noted the news.")
    await through(t1, ["ringing", "working", holds("t2", "t1", "delivered"), "settled"], {
      after: pressed,
    })
    // The command never ran: no call of the agent's conversation ever looked at its result.
    expect(
      run.model.calls.slice(calls).filter((call) => helper(call) && result(call) !== undefined),
    ).toEqual([])
  })
})
