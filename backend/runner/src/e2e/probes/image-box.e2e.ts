// PROBE, not a test of Novadeck: what each harness's box shows when image paths are pasted
// into it, with text pasted after, with a path that holds a space written three ways, and
// what the record holds once sent. Runs only with NOVADECK_E2E_PROBES=1, by path; PROBE_ONLY
// (a regular expression) picks scenarios by name. Writes $PROBE_OUT/<agent>-image-box.json.
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
import { start } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const profiles = { claude: claudeBox, codex: codexBox, agy: agyBox }

const picture = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

type Scenario = {
  readonly name: string
  /** Files to write under the project, then the steps with their pastes (paths relative to it). */
  readonly steps: readonly ((project: string) => string)[]
  /** Keys pressed after the pastes, one at a time, each looked at. */
  readonly after?: readonly (readonly [string, string])[]
  readonly send?: boolean
}

const one = (project: string) => join(project, "one.png")
const two = (project: string) => join(project, "two.png")
const spaced = (project: string) => join(project, "my dir", "pic ture.png")

const scenarios: readonly Scenario[] = [
  { name: "image then text", steps: [one, () => "Look at this"], send: true },
  { name: "two images then text", steps: [one, two, () => "Compare them"], send: true },
  {
    name: "image then long text",
    steps: [one, () => "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq"],
  },
  { name: "image only", steps: [one], send: true },
  // An image among the words, where the person put it: is it taken there, and where does it
  // show in the box and the record?
  { name: "text, image, text", steps: [() => "See this: ", one, () => " and fix it"], send: true },
  {
    name: "text, image, text, image",
    steps: [() => "Compare ", one, () => " with ", two],
    send: true,
  },
  {
    name: "clear keys",
    steps: [one],
    after: [
      ["backspace", "\x7f"],
      ["ctrl-u", "\x15"],
      ["ctrl-c", "\x03"],
      ["escape", "\x1b"],
      ["escape escape", "\x1b\x1b"],
      ["ctrl-o", "\x0f"],
      ["backspace again", "\x7f"],
    ],
  },
  // The clear keys with words in the box beside the image (a failed prompt with images among its
  // words must leave the box as it found it): which take the words, which the attachment?
  {
    name: "text and image, clear keys",
    steps: [() => "See this: ", one, () => "[Image #1] and more"],
    after: [
      ["escape", "\x1b"],
      ["ctrl-u", "\x15"],
      ["escape again", "\x1b"],
    ],
  },
  {
    name: "text and image, ctrl-u first",
    steps: [() => "See this: ", one],
    after: [
      ["ctrl-u", "\x15"],
      ["escape", "\x1b"],
    ],
  },
  { name: "spaced raw", steps: [spaced] },
  { name: "spaced escaped", steps: [(project) => spaced(project).replaceAll(" ", "\\ ")] },
  { name: "spaced quoted", steps: [(project) => `"${spaced(project)}"`] },
]

const only = process.env.PROBE_ONLY ? new RegExp(process.env.PROBE_ONLY) : undefined
const chosen = scenarios.filter(({ name }) => only?.test(name) ?? true)
const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: images in ${setup.name}`, () => {
    const it = e2e(setup)
    const profile = profiles[setup.agent]

    for (const scenario of chosen) {
      it(scenario.name, async ({ e2e: run }) => {
        run.model.use(() => ({ text: "Noted." }))
        for (const file of [one, two]) writeFileSync(file(run.sandbox.project), picture)
        mkdirSync(join(run.sandbox.project, "my dir"), { recursive: true })
        writeFileSync(spaced(run.sandbox.project), picture)
        const t = await start(run, setup)
        const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
        const record: unknown[] = []
        const look = async (label: string) => {
          const screen: ScreenText | undefined = await t.screenText()
          record.push({
            label,
            box: (screen && profile.read(screen)) ?? null,
            screen: screen ? screenRecord(screen) : null,
          })
        }
        await look("start")
        for (const step of scenario.steps) {
          raw(paste(step(run.sandbox.project)))
          await sleep(1500)
          await look(step(run.sandbox.project))
        }
        for (const [label, keys] of scenario.after ?? []) {
          raw(keys)
          await sleep(1200)
          await look(label)
        }
        if (scenario.send) {
          raw("\r")
          await sleep(4000)
          await look("sent")
        }
        const calls = run.model.calls
        const transcript = await t.transcript().catch(() => [])
        const entry = {
          record,
          calls: JSON.stringify(calls).slice(0, 3000),
          transcript: transcript
            .filter((item) => item.kind === "text")
            .map((item) => ({ role: item.role, text: item.text.slice(0, 500) })),
        }
        mkdirSync(outDir, { recursive: true })
        const path = join(outDir, `${setup.agent}-image-box.json`)
        const out = existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
          : {}
        out[scenario.name] = entry
        writeFileSync(path, JSON.stringify(out, null, 2))
      })
    }
  })
}
