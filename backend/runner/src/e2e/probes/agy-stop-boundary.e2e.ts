import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { ServerResponse } from "node:http"
import { join } from "node:path"

import { box } from "@novadeck/harness-agy/box"
import type { Report } from "@novadeck/harness-core/report"
import type { TranscriptItem } from "@novadeck/protocol"

import type { Delivery } from "../../messaging/delivery.js"
import type { HookAnswer } from "../../shell/reports.js"
import type { Bound } from "../../terminals/record.js"
import { agy } from "../agents/agy.js"
import { describe, e2e, expect, supported } from "../fixture.js"
import { installHarness, pins } from "../install.js"
import { asked } from "../model/script.js"
import { own, replies, start } from "../scenarios.js"

// Forensic opt-in only. Preserve the original ungated scenario: in particular no Stop
// await, reply hold, delay, resend, or added settling check between Five and Then.
const enabled = process.env.AGY_CAPTURE === "1" && process.env.NOVADECK_E2E_PROBES === "1"
type Process = {
  pid: number
  write: (data: string) => void
  onData: (listen: (data: string) => void) => { dispose: () => void }
}
type Record = { terminal: { pty: Process }; bound: Pick<Bound, "binding"> | null }
type Inside = {
  records: Map<string, Record>
  reporting: { report: (report: Report, deadline?: number) => Promise<HookAnswer> }
  messaging: { delivery: (id: string) => Delivery | undefined }
}

describe.skipIf(!enabled || !supported)("Antigravity natural Stop boundary capture", () => {
  const it = e2e(agy)
  it("preserves the original back-to-back prompt order", async ({ e2e: run }) => {
    expect(pins.agy?.version).toBe("1.2.14")
    const folder = process.env.AGY_CAPTURE_OUT!
    mkdirSync(folder, { recursive: true })
    const zero = performance.now()
    const secrets = new Set([run.model.credential])
    const serialize = (value: unknown, pretty = false) => {
      let text = JSON.stringify(value, null, pretty ? 2 : undefined)
      for (const secret of secrets) text = text.replaceAll(secret, "<redacted-capture-token>")
      return text
    }
    const save = (name: string, value: unknown) =>
      writeFileSync(join(folder, name), serialize(value, true))
    // No disk I/O on the timing boundary; bounded buffers flush before teardown.
    const events: object[] = []
    const output: object[] = []
    let eventOverflow = false
    let outputOverflow = false
    let bytes = 0
    const record = (type: string, extra: object = {}) => {
      if (events.length < 5_000)
        events.push({ at: Date.now(), ms: performance.now() - zero, type, ...extra })
      else eventOverflow = true
    }
    const binding = (id: string) => {
      const found = inside.records.get(id)?.bound?.binding ?? null
      return found && { agent: found.agent, sessionId: found.sessionId, instance: found.instance }
    }
    const delivery = (id: string) => {
      const found = inside.messaging.delivery(id)
      if (!found) return undefined
      const input = found.box
      return {
        state: found.state,
        epoch: found.epoch,
        byPerson: found.byPerson,
        phase: found.state === "working" ? found.phase : undefined,
        box: {
          empty: input.empty,
          queuing: input.queuing,
          queuingSince: input.queuingSince,
          enteredAt: input.enteredAt,
          typedAt: input.typedAt,
          escapedAt: input.escapedAt,
          typedSinceEnter: input.typedSinceEnter,
          strayed: input.strayed,
          queued: input.queued,
          draftWhileAsked: input.draftWhileAsked,
          doubted: input.doubted,
        },
      }
    }
    const installed = await installHarness("agy")
    expect(installed.version).toBe("1.2.14")
    const binary = join(installed.bin, "agy")
    save("identity.json", {
      scenario: "original-natural-order",
      version: installed.version,
      binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
      node: process.version,
    })
    run.model.use(
      (call) => {
        record("model.call.decoded", {
          api: call.api,
          model: call.model,
          side: call.side,
          turns: call.turns,
        })
        return undefined
      },
      replies("First quick", "Did first."),
      replies("Second quick", "Did second."),
      own((call) =>
        agy.steers && asked(call, "Third one") && asked(call, "Fourth one")
          ? { text: "Did third. Did fourth." }
          : undefined,
      ),
      replies("Third one", "Did third."),
      replies("Fourth one", "Did fourth."),
      replies("Five\nlines\nof\nit\nhere", "Did five."),
      replies("Then one", "Did then."),
    )
    const responses = new WeakMap<ServerResponse, number>()
    let nextResponse = 0
    const write = ServerResponse.prototype.write
    const end = ServerResponse.prototype.end
    ServerResponse.prototype.write = function (...args: unknown[]) {
      const chunk = String(args[0])
      if (chunk.includes('"candidates":')) {
        if (!responses.has(this)) {
          const id = ++nextResponse
          responses.set(this, id)
          this.once("finish", () => record("model.http.finish", { id }))
          this.once("close", () => record("model.http.close", { id }))
        }
        record("model.http.write", { id: responses.get(this), chunk })
      }
      return Reflect.apply(write, this, args) as boolean
    }
    ServerResponse.prototype.end = function (...args: unknown[]) {
      if (responses.has(this)) record("model.http.end.called", { id: responses.get(this) })
      const result = Reflect.apply(end, this, args) as ServerResponse
      if (responses.has(this)) record("model.http.end.returned", { id: responses.get(this) })
      return result
    }
    const inside = run.deck.terminals as unknown as Inside
    const report = inside.reporting.report
    inside.reporting.report = async function (incoming, deadline) {
      secrets.add(incoming.token)
      record("hook.received", {
        agent: incoming.agent,
        event: incoming.event,
        instance: incoming.instance,
        seq: incoming.seq,
        firedAt: incoming.firedAt,
      })
      const answer = await report.call(this, incoming, deadline)
      record("hook.response", {
        agent: incoming.agent,
        event: incoming.event,
        stdout: answer.stdout,
        binding: binding(incoming.terminalId),
        delivery: delivery(incoming.terminalId),
      })
      return answer
    }
    let child: Process | undefined
    let original: Process["write"] | undefined
    let native: { dispose: () => void } | undefined
    let outcome = "scenario-error"
    let stage = "startup"
    let final: { queued: boolean; generating: boolean } | undefined
    let thenEntered = false
    let thenPasted = false
    try {
      const terminal = await start(run, agy)
      child = inside.records.get(terminal.id)!.terminal.pty
      original = child.write
      const state = () => ({
        binding: binding(terminal.id),
        delivery: delivery(terminal.id),
        activity: terminal.summary().activity?.state,
      })
      child.write = function (data) {
        record("pty.input", { data, ...state() })
        const result = original!.call(this, data)
        if (data.includes("Then one")) thenPasted = true
        if (thenPasted && data === "\r") thenEntered = true
        return result
      }
      native = child.onData((data) => {
        bytes += Buffer.byteLength(data)
        if (bytes <= 8 * 1024 * 1024 && output.length < 8_192)
          output.push({ at: Date.now(), ms: performance.now() - zero, data })
        else outputOverflow = true
      })
      const capture = async (name: string) => {
        const screen = await terminal.screenText()
        if (name === "final")
          final = {
            queued: Boolean(screen && box.queued(screen)),
            generating: Boolean(screen?.rows.some((row) => row.includes("Generating"))),
          }
        save(`${name}.json`, {
          at: Date.now(),
          ms: performance.now() - zero,
          ...state(),
          screen,
          input: screen && box.read(screen),
          queued: screen && box.queued(screen),
        })
        try {
          save(
            `${name}-transcript.json`,
            (await terminal.transcript())
              .filter((one) => one.kind === "text")
              .map((one) => ({ index: one.index, role: one.role, kind: one.kind, text: one.text })),
          )
        } catch (error) {
          record("transcript.error", { error: String(error) })
        }
      }
      const texts = async (role: TranscriptItem["role"]) =>
        (await terminal.transcript())
          .filter((one) => one.role === role && one.kind === "text")
          .map((one) => one.text)
      const item = (needle: string) =>
        terminal.poll(
          async () => {
            try {
              return (await texts("assistant")).find((text) => text.includes(needle))
            } catch (error) {
              if ((error as { code?: string }).code === "NOT_FOUND") return undefined
              throw error
            }
          },
          `its transcript to hold ${needle}`,
          30_000,
        )
      await capture("initial")
      record("scenario.begin")
      try {
        stage = "first-second"
        await terminal.prompt("First quick")
        await terminal.prompt("Second quick")
        await item("Did second.")
        stage = "third-fourth"
        await Promise.all([terminal.prompt("Third one"), terminal.prompt("Fourth one")])
        await item("Did fourth.")
        stage = "five-then"
        await terminal.prompt("Five\nlines\nof\nit\nhere")
        await terminal.prompt("Then one")
        stage = "reply-waits"
        for (const reply of ["Did first.", "Did second.", "Did third.", "Did fourth.", "Did then."])
          // eslint-disable-next-line no-await-in-loop -- Preserve the original reply waits in order.
          await item(reply)
        stage = "exact-once"
        const users = await texts("user")
        for (const sent of ["First quick", "Second quick", "Third one", "Fourth one", "Then one"])
          expect(
            users.filter((text) => (agy.steers ? text.includes(sent) : text === sent)),
          ).toHaveLength(1)
        outcome = "delivered"
      } catch (error) {
        const received = run.model.calls.some((call) => !call.side && asked(call, "Then one"))
        outcome =
          thenEntered && !received ? "submitted-followup-never-reached-model" : "scenario-error"
        record("scenario.failure", { outcome, stage, error: String(error) })
        throw error
      } finally {
        await capture("final")
        save("history.json", terminal.history())
      }
    } finally {
      if (child && original) child.write = original
      native?.dispose()
      delete (inside.reporting as Partial<Inside["reporting"]>).report
      ServerResponse.prototype.write = write
      ServerResponse.prototype.end = end
      save("summary.json", {
        outcome,
        stage,
        final,
        thenPasted,
        thenEntered,
        eventOverflow,
        outputOverflow,
      })
      writeFileSync(
        join(folder, "events.jsonl"),
        events.map((one) => serialize(one)).join("\n") + "\n",
      )
      writeFileSync(
        join(folder, "native-output.jsonl"),
        output.map((one) => serialize(one)).join("\n") + "\n",
      )
    }
  })
})
