// PROBE, not a test of Novadeck: what each harness does with a box that already holds something
// when more arrives: a paste appended to a draft (where it lands, what Enter sends, what the
// record holds), over a placeholder or an open picker, and mid-turn; which key clears what the box
// holds, idle and mid-turn, on one line, several, or a placeholder; and which key leaves its shell
// mode, empty or holding a command. Each scenario gets a terminal of its own. Runs only with
// NOVADECK_E2E_PROBES=1, by path; PROBE_ONLY (a regular expression) picks scenarios by name.
// Writes $PROBE_OUT/<agent>-leftover-<version>.json, each step a `ScreenRecord` with the box as
// the adapter reads it. The adapters' fixtures (harnesses/*/src/fixtures/leftover.probe.json) are
// a choice of those screens, of the pinned versions.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

import type { ScreenText } from "@novadeck/emulator/headless"
import { box as agyBox } from "@novadeck/harness-agy/box"
import { box as claudeBox } from "@novadeck/harness-claude/box"
import { box as codexBox } from "@novadeck/harness-codex/box"
import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { gate, type Call } from "../model/script.js"
import { start } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const profiles = { claude: claudeBox, codex: codexBox, agy: agyBox }

const left = "\x1b[D"
const up = "\x1b[A"
const down = "\x1b[B"
const home = "\x1b[H"
const end = "\x1b[F"
const ctrlEnd = "\x1b[1;5F"
const ctrlA = "\x01"
const ctrlE = "\x05"
const ctrlU = "\x15"
const ctrlK = "\x0b"
const ctrlC = "\x03"
const esc = "\x1b"
const backspace = "\x7f"
const enter = "\r"

/** One step: keys as a person would press them, or a paste, or a wait with no key. */
type Step =
  | { readonly label: string; readonly keys: string; readonly wait?: number }
  | { readonly label: string; readonly paste: string; readonly wait?: number }

const k = (label: string, keys: string, wait?: number): Step => ({
  label,
  keys,
  ...(wait !== undefined && { wait }),
})
const p = (label: string, words: string): Step => ({ label, paste: words })

const longLines = Array.from(
  { length: 40 },
  (_, index) =>
    `Line ${index + 1} of the long paste, with words enough to pass the length a box shows`,
).join("\n")
const threeLines = "line one\nline two\nline three"

type Scenario = {
  readonly name: string
  /** A turn is held running first, and let go at the end. */
  readonly midTurn?: boolean
  /** The project holds a file for a picker to offer. */
  readonly project?: boolean
  readonly steps: readonly Step[]
}

const typed = k("type draft", "half typed", 800)

// A clear's key tried on what the box holds.
const clearKeys: readonly (readonly [string, string])[] = [
  ["esc", esc],
  ["esc esc", esc + esc],
  ["ctrl-u", ctrlU],
  ["ctrl-c", ctrlC],
  ["ctrl-a ctrl-k", ctrlA + ctrlK],
]

// Keys tried on a shell mode that holds a command.
const shellKeys: readonly (readonly [string, string])[] = [
  ["esc", esc],
  ["esc esc", esc + esc],
  ["ctrl-u", ctrlU],
  ["ctrl-u backspace", ctrlU + backspace],
  ["home backspace", home + backspace],
  ["ctrl-a backspace", ctrlA + backspace],
  ["ctrl-c", ctrlC],
]

const scenarios: readonly Scenario[] = [
  // A handover: what a paste with no Enter does in an empty box, and what the erase takes.
  ...(
    [
      ["plain", "a draft from the chat"],
      ["two lines", "first line\nsecond line"],
      ["blank line", "first\n\nthird"],
      ["trailing line break", "first line\n"],
      ["slash", "/help me"],
      ["bang", "!ls -la"],
      ["at sign", "see @notes"],
      ["dollar", "see $sk"],
      ["question mark", "?"],
      ["long", longLines],
    ] as const
  ).flatMap(([label, words]): Scenario[] => [
    {
      name: `handover paste idle: ${label}`,
      project: true,
      steps: [p("paste", words), k("wait", "", 2000)],
    },
    {
      name: `handover paste mid-turn: ${label}`,
      project: true,
      midTurn: true,
      steps: [p("paste", words), k("wait", "", 2000)],
    },
  ]),
  ...(["/he", "see @notes", "see $sk"] as const).map((words): Scenario => ({
    name: `handover erase with a picker open: ${words}`,
    project: true,
    steps: [k("type", words, 1500), k("erase", ctrlU, 1500), k("wait", "", 500)],
  })),
  {
    name: "wrap: hard line breaks at the width",
    steps: [
      p(
        "draft",
        [
          "short line",
          `${"exactly wide words ".repeat(5)}end`,
          "x".repeat(150),
          "next line",
          "tail of a long paragraph which is long enough that it needs to wrap over the width of the screen at least once and keeps going",
        ].join("\n"),
      ),
    ],
  },
  // What a menu or picker over the box reads as.
  ...["/model", "/config", "/resume", "/status", "/help", "/mcp", "/permissions", "/theme"].map(
    (command): Scenario => ({
      name: `menu ${command}`,
      steps: [k("type", command, 1000), k("enter", enter, 2000), k("wait", "", 500)],
    }),
  ),
  // Appending.
  {
    name: "append bare",
    steps: [typed, p("paste", " and more"), k("enter", enter, 3000)],
  },
  {
    name: "append with blank line",
    steps: [typed, p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "append after a pasted draft",
    steps: [p("draft", "pasted draft"), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "cursor moved left",
    steps: [
      typed,
      k("left x4", left.repeat(4)),
      p("paste mid", "XX"),
      k("end", end),
      p("paste after end", "YY"),
      k("left x4", left.repeat(4)),
      k("ctrl-e", ctrlE),
      p("paste after ctrl-e", "ZZ"),
      k("enter", enter, 3000),
    ],
  },
  {
    name: "cursor up a multi-line draft",
    steps: [
      p("draft", threeLines),
      k("up x2", up.repeat(2)),
      k("end", end),
      p("paste after end", "AA"),
      k("ctrl-end", ctrlEnd),
      p("paste after ctrl-end", "BB"),
      k("ctrl-e", ctrlE),
      p("paste after ctrl-e", "CC"),
      k("enter", enter, 3000),
    ],
  },
  {
    name: "append to a multi-line draft",
    steps: [p("draft", threeLines), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "append to a placeholder",
    steps: [p("draft", longLines), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "append a long message",
    steps: [typed, p("paste", `\n\n${longLines}`), k("enter", enter, 3000)],
  },
  // The cursor sent back to the end of the text: down to the last row, then End.
  {
    name: "cursor home on three lines, down and end",
    steps: [
      p("draft", threeLines),
      k("up x2", up.repeat(2)),
      k("left x3", left.repeat(3)),
      k("down x2", down.repeat(2)),
      k("end", end),
      p("paste", "\n\nthe message"),
      k("enter", enter, 3000),
    ],
  },
  {
    name: "cursor mid one line, end",
    steps: [typed, k("left x4", left.repeat(4)), k("end", end), p("paste", "\n\nthe message")],
  },
  {
    name: "cursor in a wrapped line, down and end",
    steps: [
      p("draft", "wrapping words ".repeat(20).trim()),
      k("up", up),
      k("down", down),
      k("end", end),
      p("paste", "\n\nthe message"),
      k("enter", enter, 3000),
    ],
  },
  // Pickers a draft may hold open, with something for them to offer.
  {
    name: "picker open at sign",
    project: true,
    steps: [k("type", "see @notes", 1500), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "picker open at sign, bare enter",
    project: true,
    steps: [k("type", "see @notes", 1500), k("enter", enter, 2000)],
  },
  {
    name: "picker open slash mid-text",
    project: true,
    steps: [k("type", "try /mod", 1500), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "picker open at sign, moved down",
    project: true,
    steps: [
      k("type", "see @notes", 1500),
      k("down", down, 800),
      p("paste", "\n\nthe message"),
      k("enter", enter, 3000),
    ],
  },
  // Pickers a draft may hold open.
  {
    name: "picker at sign",
    steps: [k("type", "see @sr", 1000), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "picker at sign, bare paste",
    steps: [k("type", "see @sr", 1000), p("paste", " more words"), k("enter", enter, 3000)],
  },
  {
    name: "picker dollar",
    steps: [k("type", "see $sk", 1000), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "picker hash",
    steps: [k("type", "see #is", 1000), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  {
    name: "slash leading",
    steps: [k("type", "/he", 1000), p("paste", "\n\nthe message"), k("wait", "", 500)],
  },
  {
    name: "slash mid-text",
    steps: [k("type", "try /he", 1000), p("paste", "\n\nthe message"), k("enter", enter, 3000)],
  },
  // Mid-turn.
  {
    name: "append mid-turn",
    midTurn: true,
    steps: [typed, p("paste", "\n\nthe message"), k("enter", enter, 2000)],
  },
  // Clearing.
  ...clearKeys.flatMap(([label, keys]): Scenario[] => [
    { name: `clear idle one line: ${label}`, steps: [typed, k(label, keys, 1500)] },
    {
      name: `clear idle three lines: ${label}`,
      steps: [p("draft", threeLines), k(label, keys, 1500)],
    },
    {
      name: `clear idle placeholder: ${label}`,
      steps: [p("draft", longLines), k(label, keys, 1500)],
    },
    {
      name: `clear mid-turn one line: ${label}`,
      midTurn: true,
      steps: [typed, k(label, keys, 1500)],
    },
  ]),
  {
    name: "clear idle three lines: agy's ctrl-u and backspaces",
    steps: [p("draft", threeLines), k("clear", `${(ctrlU + backspace).repeat(2)}${ctrlU}`, 1500)],
  },
  {
    name: "clear mid-turn three lines: agy's ctrl-u and backspaces",
    midTurn: true,
    steps: [p("draft", threeLines), k("clear", `${(ctrlU + backspace).repeat(2)}${ctrlU}`, 1500)],
  },
  ...[1, 2, 3].map((run): Scenario => ({
    name: `clear idle wrapped: ctrl-u and backspaces ${run}`,
    steps: [
      p("draft", "wrapping words ".repeat(20).trim()),
      k("clear", `${(ctrlU + backspace).repeat(2)}${ctrlU}`, 1500),
    ],
  })),
  {
    name: "clear mid-turn wrapped: ctrl-u and backspaces",
    midTurn: true,
    steps: [
      p("draft", "wrapping words ".repeat(20).trim()),
      k("clear", `${(ctrlU + backspace).repeat(2)}${ctrlU}`, 1500),
    ],
  },
  {
    name: "clear mid-turn placeholder: ctrl-u",
    midTurn: true,
    steps: [p("draft", longLines), k("clear", ctrlU, 1500)],
  },
  // Shell mode.
  {
    name: "shell with text, wrapped: ctrl-u backspace",
    steps: [
      k("bang", "!", 1000),
      p("paste", "echo words ".repeat(20).trim()),
      k("keys", ctrlU + backspace, 1500),
    ],
  },
  {
    name: "shell with text, wrapped: all rows",
    steps: [
      k("bang", "!", 1000),
      p("paste", "echo words ".repeat(20).trim()),
      k("keys", `${ctrlU + backspace}${ctrlU + backspace}`, 1500),
    ],
  },
  { name: "shell empty: esc", steps: [k("bang", "!", 1000), k("esc", esc, 1500)] },
  { name: "shell empty: backspace", steps: [k("bang", "!", 1000), k("bs", backspace, 1500)] },
  {
    name: "shell empty mid-turn: backspace",
    midTurn: true,
    steps: [k("bang", "!", 1000), k("bs", backspace, 1500)],
  },
  {
    name: "shell empty mid-turn: esc",
    midTurn: true,
    steps: [k("bang", "!", 1000), k("esc", esc, 1500)],
  },
  ...shellKeys.flatMap(([label, keys]): Scenario[] => [
    {
      name: `shell with text: ${label}`,
      steps: [k("bang", "!", 1000), k("type", "ls -la", 800), k(label, keys, 1500)],
    },
  ]),
  {
    name: "shell with text mid-turn: ctrl-u backspace",
    midTurn: true,
    steps: [
      k("bang", "!", 1000),
      k("type", "ls -la", 800),
      k("ctrl-u backspace", ctrlU + backspace, 1500),
    ],
  },
]

/** The keys in plain form: a line of `\xNN`s reads better in the record than raw controls. */
const shown = (keys: string): string =>
  // eslint-disable-next-line no-control-regex -- Control characters are what it shows.
  keys.replace(/[\x00-\x1f\x7f]/g, (key) => `\\x${key.charCodeAt(0).toString(16).padStart(2, "0")}`)

const only = process.env.PROBE_ONLY ? new RegExp(process.env.PROBE_ONLY) : undefined
const chosen = scenarios.filter(({ name }) => only?.test(name) ?? true)
const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: leftovers in ${setup.name}`, () => {
    const it = e2e(setup)
    const profile = profiles[setup.agent]

    for (const scenario of chosen) {
      it(scenario.name, async ({ e2e: run }) => {
        const held = gate()
        run.model.use(
          async (call: Call) => {
            if (call.side) return { text: "ok" }
            const said = JSON.stringify(call)
            if (said.includes("Hold on") && !said.includes("Held.")) {
              await held.opened
              return { text: "Held." }
            }
            return undefined
          },
          () => ({ text: "Noted." }),
        )
        if (scenario.project) writeFileSync(join(run.sandbox.project, "notes.md"), "Notes.\n")
        const t = await start(run, setup)
        const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
        const record: unknown[] = []
        const look = async (label: string, keys?: string) => {
          const screen: ScreenText | undefined = await t.screenText()
          const read = screen && profile.read(screen)
          record.push({
            label,
            ...(keys !== undefined && { keys: shown(keys) }),
            box: read ?? null,
            overlay: screen ? profile.overlay(screen) : null,
            queued: screen ? profile.queued(screen) : null,
            screen: screen ? screenRecord(screen) : null,
            state: t.summary().activity?.state ?? null,
          })
        }
        if (scenario.midTurn) {
          await t.prompt("Hold on")
          await t.poll(
            () => (t.summary().activity?.state === "working" ? true : undefined),
            "its turn to run",
          )
          await sleep(1000)
        }
        await look("start")
        for (const step of scenario.steps) {
          const keys = "keys" in step ? step.keys : paste(step.paste)
          if (keys !== "") raw(keys)
          await sleep(step.wait ?? 1000)
          await look(step.label, "keys" in step ? keys : undefined)
        }
        if (scenario.midTurn) {
          held.open()
          await sleep(4000)
          await look("after the turn")
        }
        const transcript = await t.transcript().catch(() => [])
        const entry = {
          record,
          transcript: transcript
            .filter((item) => item.kind === "text")
            .map((item) => ({ role: item.role, text: item.text.slice(0, 1500) })),
        }
        mkdirSync(outDir, { recursive: true })
        const path = join(outDir, `${setup.agent}-leftover-${setup.agent}.json`)
        const out = existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
          : {}
        out[scenario.name] = entry
        writeFileSync(path, JSON.stringify(out, null, 2))
      })
    }
  })
}
