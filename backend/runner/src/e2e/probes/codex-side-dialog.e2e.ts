// PROBE, not a test of Novadeck: where Codex draws the root's dialog while a `/side`
// conversation is open, and which pane has the cursor. The root's turn runs a command, and
// when it ends, asks an approval (`exec_command` with `require_escalated`). Scenarios: the side conversation opened mid-turn and in focus
// when the dialog comes (then Ctrl-/ to the root, and the dialog answered there); the side
// opened after a first turn (it waits for the conversation to start), Ctrl-/ back to the root
// before the prompt, so the root is in focus with the sidebar
// beside it; and the same on a 99-column screen, where the side takes the whole screen. Runs
// only with NOVADECK_E2E_PROBES=1 and NOVADECK_E2E_AGENTS=codex, by path, once per version;
// writes $PROBE_OUT/codex-side-dialog-<version>.json, for
// harnesses/codex/src/fixtures/side-dialog.probe.json (paths in it scrubbed).
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { sideToggle } from "@novadeck/harness-codex/box"
import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate, type Call, type Reply } from "../model/script.js"
import { prompted, turn } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
const setup = setups.find((each) => each.agent === "codex")!
// As this platform's terminal sends it: a bare 0x1F is no Ctrl-/ to Codex on Windows.
const ctrlSlash = sideToggle()

const calls = {
  permission: {
    name: "exec_command",
    input: {
      cmd: "echo approved > probe-out.txt",
      sandbox_permissions: "require_escalated",
      justification: "Echo outside the sandbox",
    },
  },
}

const states: Record<string, unknown> = {}
let version = "unknown"
const write = () => {
  mkdirSync(outDir, { recursive: true })
  // The sandbox's folders are the machine's, not the fixture's; masked as wide, for a split
  // screen's divider stands at the same column on every row.
  const text = JSON.stringify({ version, facts: calls, states }, null, 2)
    .replace(/novadeck-e2e-\w{6}/g, "novadeck-e2e-XXXXXX")
    .replace(/\be2e-\w{6}\b/g, "e2e-XXXXXX")
  writeFileSync(join(outDir, `codex-side-dialog-${version}.json`), text)
}

type Scenario = {
  readonly kind: keyof typeof calls
  /** Where focus is when the dialog comes. */
  readonly focus: "side" | "root"
  readonly columns: number
}

const scenarios: Readonly<Record<string, Scenario>> = {
  permissionSide: { kind: "permission", focus: "side", columns: 120 },
  permissionRoot: { kind: "permission", focus: "root", columns: 120 },
  permissionNarrow: { kind: "permission", focus: "side", columns: 99 },
}

describe.skipIf(!supported || !probing || !setup)("probe: a root dialog beside /side", () => {
  const it = e2e(setup)
  const settled = async (t: DeckTerminal, forMs = 800): Promise<void> => {
    let last = { shown: "", since: Date.now() }
    const until = Date.now() + 4_000
    while (Date.now() < until) {
      const shown = await t.screen()
      if (shown !== last.shown) last = { shown, since: Date.now() }
      if (Date.now() - last.since >= forMs) return
      await sleep(100)
    }
  }

  for (const [name, { kind, focus, columns }] of Object.entries(scenarios)) {
    it(`${name}: the root's dialog with a side conversation open`, async ({ e2e: run }) => {
      const release = gate()
      run.model.use(async (call: Call): Promise<Reply | undefined> => {
        if (call.side) return undefined
        if (asked(call, "Warm up")) return { text: "Warmed up." }
        const tools = call.turns.filter((one) => one.role === "tool").length
        if (asked(call, "Run the thing") && tools === 0)
          return {
            calls: [
              {
                name: "exec_command",
                input: { cmd: "sleep 8; echo slept", yield_time_ms: 30_000 },
              },
            ],
          }
        if (tools === 1) {
          await release.opened
          return { calls: [calls[kind]] }
        }
        if (tools >= 2) return { text: "Finished the request." }
        return undefined
      })
      const t = await run.deck.open("codex")
      // In sight, so Novadeck's dialog tracker presses nothing to bring a dialog into view: what
      // is recorded is Codex's alone.
      run.deck.seen.report("e2e", [t.id])
      await t.reached("ready", { timeoutMs: 60_000 })
      await prompted(t, setup)
      version = /OpenAI Codex \(v(\d+\.\d+\.\d+)\)/.exec(await t.screen())?.[1] ?? version
      if (columns !== 120) {
        t.resize(columns, 40)
        await sleep(1_500)
      }
      const take = async (state: string, wait = 1_500) => {
        await sleep(wait)
        await settled(t)
        states[`${name}${state}`] = screenRecord((await t.screenText())!)
        write()
      }
      const side = async () => {
        run.deck.terminals.write({ terminalId: t.id, data: "/side" }, "e2e")
        await sleep(800)
        run.deck.terminals.write({ terminalId: t.id, data: "\r" }, "e2e")
      }
      if (focus === "root") {
        // `/side` waits for the conversation to have started.
        await turn(t, "Warm up", "Warmed up.")
        await side()
        await take("SideOpen", 3_000)
        t.press(ctrlSlash)
        await take("RootBack")
        await t.prompt("Run the thing")
      } else {
        await t.prompt("Run the thing")
        await sleep(2_000)
        await side()
        await take("SideOpen", 3_000)
      }
      release.open()
      // The command ends about 8 s after it began, and the dialog is asked then.
      await sleep(9_000)
      await take("Held")
      t.press(ctrlSlash)
      await take("Switched")
      t.press(ctrlSlash)
      await take("SwitchedAgain")
      t.press(ctrlSlash)
      await take("SwitchedThird")
      // Answer it, where the root's pane has the focus.
      t.press("y")
      await take("Answered", 3_000)
      write()
    })
  }
})

// Where Codex leaves its cursor, frame by frame, with the root's approval up and in focus while
// the side conversation's turn runs beside it (its timer ticking in the sidebar); and whether an
// approval the side conversation's own turn asks reaches Novadeck as the terminal's request.
describe.skipIf(!supported || !probing || !setup)(
  "probe: /side mid-turn and its own approval",
  () => {
    const it = e2e(setup)

    it("sideBusy: the root's approval in focus, the side's turn running", async ({ e2e: run }) => {
      const release = gate()
      const sideDone = gate()
      run.model.use(async (call: Call): Promise<Reply | undefined> => {
        if (call.side) return undefined
        if (asked(call, "Warm up")) return { text: "Warmed up." }
        if (asked(call, "Ask on the side")) {
          await sideDone.opened
          return { text: "Answered on the side." }
        }
        const tools = call.turns.filter((one) => one.role === "tool").length
        if (asked(call, "Run the thing") && tools === 0)
          return {
            calls: [
              {
                name: "exec_command",
                input: { cmd: "sleep 8; echo slept", yield_time_ms: 30_000 },
              },
            ],
          }
        if (tools === 1) {
          await release.opened
          return { calls: [calls.permission] }
        }
        if (tools >= 2) return { text: "Finished the request." }
        return undefined
      })
      const t = await run.deck.open("codex")
      run.deck.seen.report("e2e", [t.id])
      await t.reached("ready", { timeoutMs: 60_000 })
      await prompted(t, setup)
      version = /OpenAI Codex \(v(\d+\.\d+\.\d+)\)/.exec(await t.screen())?.[1] ?? version
      const record = async (state: string) => {
        states[`sideBusy${state}`] = screenRecord((await t.screenText())!)
        write()
      }
      await turn(t, "Warm up", "Warmed up.")
      run.deck.terminals.write({ terminalId: t.id, data: "/side" }, "e2e")
      await sleep(800)
      run.deck.terminals.write({ terminalId: t.id, data: "\r" }, "e2e")
      await sleep(3_000)
      run.deck.terminals.write({ terminalId: t.id, data: "Ask on the side" }, "e2e")
      await sleep(800)
      run.deck.terminals.write({ terminalId: t.id, data: "\r" }, "e2e")
      await sleep(2_000)
      await record("SideWorking")
      t.press(ctrlSlash)
      await sleep(1_500)
      await record("RootBack")
      await t.prompt("Run the thing")
      release.open()
      await sleep(10_000)
      await record("Held")
      // Each frame's cursor, the side's timer ticking: where a hidden cursor is parked.
      const frames: unknown[] = []
      for (let at = 0; at < 60; at++) {
        const screen = (await t.screenText())!
        frames.push({ cursor: screen.cursor, row: screen.rows[screen.cursor.row] ?? "" })
        await sleep(100)
      }
      states.sideBusyFrames = frames
      write()
      sideDone.open()
      await sleep(2_000)
      await record("SideAnswered")
      t.press("y")
      await sleep(3_000)
      await record("Answered")
    })

    for (const columns of [120, 99]) {
      it(`sideApproval${columns}: the side conversation's own approval`, async ({ e2e: run }) => {
        run.model.use(async (call: Call): Promise<Reply | undefined> => {
          if (call.side) return undefined
          if (asked(call, "Warm up")) return { text: "Warmed up." }
          const tools = call.turns.filter((one) => one.role === "tool").length
          if (asked(call, "Ask on the side") && tools === 0) return { calls: [calls.permission] }
          if (tools >= 1) return { text: "Ran it on the side." }
          return undefined
        })
        const t = await run.deck.open("codex")
        run.deck.seen.report("e2e", [t.id])
        await t.reached("ready", { timeoutMs: 60_000 })
        await prompted(t, setup)
        version = /OpenAI Codex \(v(\d+\.\d+\.\d+)\)/.exec(await t.screen())?.[1] ?? version
        if (columns !== 120) {
          t.resize(columns, 40)
          await sleep(1_500)
        }
        const name = `sideApproval${columns}`
        const record = async (state: string) => {
          states[`${name}${state}`] = screenRecord((await t.screenText())!)
          states[`${name}${state}Requests`] = (await t.detail()).requests.map((one) => ({
            ref: one.ref,
            dialog: one.dialog?.type ?? null,
          }))
          write()
        }
        await turn(t, "Warm up", "Warmed up.")
        run.deck.terminals.write({ terminalId: t.id, data: "/side" }, "e2e")
        await sleep(800)
        run.deck.terminals.write({ terminalId: t.id, data: "\r" }, "e2e")
        await sleep(3_000)
        run.deck.terminals.write({ terminalId: t.id, data: "Ask on the side" }, "e2e")
        await sleep(800)
        run.deck.terminals.write({ terminalId: t.id, data: "\r" }, "e2e")
        await sleep(6_000)
        await record("Held")
        t.press("y")
        await sleep(3_000)
        await record("Answered")
      })
    }
  },
)
