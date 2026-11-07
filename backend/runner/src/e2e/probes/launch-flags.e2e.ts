// PROBE, and the scenario it grew into: which of the flags an agent was launched with a
// harness remembers when its session resumes, and that Novadeck brings back the rest.
// Per harness, two agents start with a permission mode: one is resumed bare, as
// `claude --resume <id>`, `codex resume <id>` or `agy --conversation <id>` did before this
// (what the harness itself remembers, probed), the other is restored by Novadeck after it
// restarts (its launch flags carried over). Runs only with NOVADECK_E2E_PROBES=1, by path;
// with PROBE_OUT set it writes $PROBE_OUT/<agent>.launch-flags.probe.json, the screens
// and launch words each step showed.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../../harnesses/registry.js"
import type { Record as TerminalRecord } from "../../terminals/record.js"
import type { SavedTerminal } from "../../terminals/saved-terminals.js"
import { setups } from "../agents/index.js"
import { describe, e2e, expect, supported } from "../fixture.js"
import { prompted, replies, turn } from "../scenarios.js"

const out = process.env.PROBE_OUT

type Case = {
  /** The permission flags it starts with, as typed. */
  readonly typed: string
  /** What `launch.kept` makes of them. */
  readonly kept: readonly string[]
  /** A command that shows its permissions, typed once its prompt is up; none where the screen does. */
  readonly status?: string
  /** What its screen shows while the mode holds. */
  readonly shows: RegExp
}

const base: { readonly [agent in AgentName]: Case } = {
  claude: {
    typed: "--permission-mode plan",
    kept: ["--permission-mode", "plan"],
    shows: /plan mode on/i,
  },
  codex: {
    typed: "--ask-for-approval never --sandbox read-only",
    kept: ["--ask-for-approval", "never", "--sandbox", "read-only"],
    status: "/status",
    shows: /read only \(never\)/i,
  },
  agy: {
    typed: "--mode plan",
    kept: ["--mode", "plan"],
    shows: /plan · /i,
  },
}

// PROBE_TYPED, PROBE_KEPT (JSON) and PROBE_SHOWS (a pattern) probe other flags than the default.
const cases = base

// The runner's records and saved rows, which only a probe reaches into.
type Inside = {
  records: Map<string, Pick<TerminalRecord, "agents">>
  saves: { saved: (id: string) => Pick<SavedTerminal, "agents"> | undefined }
}

for (const setup of setups) {
  const agent = setup.agent
  const probe: Case = {
    ...cases[agent],
    ...(process.env.PROBE_TYPED && { typed: process.env.PROBE_TYPED }),
    ...(process.env.PROBE_KEPT && { kept: JSON.parse(process.env.PROBE_KEPT) as string[] }),
    ...(process.env.PROBE_SHOWS && { shows: new RegExp(process.env.PROBE_SHOWS, "i") }),
  }
  describe.skipIf(!supported || process.env.NOVADECK_E2E_PROBES === undefined)(
    `probe: launch flags kept on resume in ${setup.name}`,
    () => {
      const it = e2e(setup)
      it("remembers what it remembers; Novadeck brings back the rest", async ({ e2e: run }) => {
        const found: Record<string, unknown> = {}
        const writeOut = (): void => {
          if (!out) return
          mkdirSync(out, { recursive: true })
          writeFileSync(
            join(out, `${agent}.launch-flags.probe.json`),
            JSON.stringify(found, null, 2),
          )
        }
        // The runner wired now: a restart replaces it.
        const inner = (): Inside => run.deck.terminals as unknown as Inside
        const launchOf = (id: string): readonly string[] | undefined =>
          (inner().records.get(id) ?? inner().saves.saved(id))?.agents[agent]?.launch
        const shown = async (terminal: {
          screen: () => Promise<string>
          submit: (text: string) => Promise<void>
        }): Promise<string> => {
          if (probe.status) {
            await terminal.submit(probe.status)
            await new Promise((resolve) => setTimeout(resolve, 2500))
          }
          return terminal.screen()
        }

        run.model.use(
          replies("Remember the word heron", "Remembered."),
          replies("Carry on", "Carried on."),
        )
        const flagged = await run.deck.open(`${agent} ${probe.typed}`)
        await flagged.reached("ready", { timeoutMs: 60_000 })
        await prompted(flagged, setup)
        await turn(flagged, "Remember the word heron", "Remembered.")
        found.launched = await shown(flagged)
        // What the relay read of its process, as its harness keeps it for a resume.
        await flagged.poll(
          () => (launchOf(flagged.id) ? true : undefined),
          "its launch flags to be reported",
          30_000,
        )
        expect(launchOf(flagged.id)).toEqual(probe.kept)
        found.keptWords = launchOf(flagged.id)

        const control = await run.deck.open(`${agent} ${probe.typed}`)
        await control.reached("ready", { timeoutMs: 60_000 })
        await prompted(control, setup)
        await turn(control, "Remember the word heron", "Remembered.")
        const controlSession = run.deck.terminals.reportedSession(control.id, agent)!

        await run.deck.restart()

        // The control's session resumed bare, as every resume was before: what the harness
        // remembers by itself.
        const bare = await run.deck.open(harnesses[agent].launch.resume!(controlSession).join(" "))
        await bare.reached("ready", { timeoutMs: 60_000 })
        await prompted(bare, setup)
        found.resumedBare = await shown(bare)
        found.bareCommand = harnesses[agent].launch.resume!(controlSession)

        // The first one restored by Novadeck: its launch flags come with the resume.
        const restored = await run.deck.restore(flagged, { resume: agent })
        await restored.reached("ready", { timeoutMs: 60_000 })
        await prompted(restored, setup)
        found.restored = await shown(restored)
        writeOut()
        expect(found.restored).toMatch(probe.shows)
        await turn(restored, "Carry on", "Carried on.")
        await restored
          .poll(
            () => (launchOf(restored.id)?.length ? true : undefined),
            "its launch flags to be reported again",
            15_000,
          )
          .catch((error: unknown) => {
            found.reportedAgain = JSON.stringify(inner().records.get(restored.id)?.agents)
            found.savedBefore = JSON.stringify(inner().saves.saved(flagged.id)?.agents)
            writeOut()
            throw error
          })
        expect(launchOf(restored.id)).toEqual(probe.kept)
        expect(run.deck.terminals.reportedSession(restored.id, agent)).toBe(
          run.deck.terminals.reportedSession(flagged.id, agent),
        )

        writeOut()
      })
    },
  )
}

// Whether a bare `codex resume` of a session launched with `--dangerously-bypass-hook-trust`
// stops at the "Hooks need review" screen, Novadeck's hooks being untrusted. Its answer decides
// whether that flag is given back (`forgets` in the Codex harness).
const codexSetup = setups.find((setup) => setup.agent === "codex")
if (codexSetup) {
  describe.skipIf(!supported || process.env.NOVADECK_E2E_PROBES === undefined)(
    "probe: hook trust bypass kept on resume in Codex",
    () => {
      const it = e2e.seeded({ hooksTrusted: false }, codexSetup)
      it("shows whether a bare resume asks to review the hooks", async ({ e2e: run }) => {
        run.model.use(replies("Remember the word heron", "Remembered."))
        const found: Record<string, unknown> = {}
        const bypassed = await run.deck.open("codex --dangerously-bypass-hook-trust")
        await prompted(bypassed, codexSetup)
        found.launchedAskedToReview = /Hooks need review/.test(await bypassed.screen())
        await bypassed.submit("Remember the word heron")
        await bypassed.until("Remembered.")
        await new Promise((resolve) => setTimeout(resolve, 6000))
        // Whether its hooks ran, so Novadeck knows the session.
        const session = run.deck.terminals.reportedSession(bypassed.id, "codex")
        found.session = session
        found.launchedScreen = await bypassed.screen()
        if (session) {
          await run.deck.restart()
          const bare = await run.deck.open(harnesses.codex.launch.resume!(session).join(" "))
          await new Promise((resolve) => setTimeout(resolve, 10_000))
          found.bareScreen = await bare.screen()
          found.bareAsksToReview = /Hooks need review/.test(String(found.bareScreen))
        }
        if (out) {
          mkdirSync(out, { recursive: true })
          writeFileSync(join(out, "codex.hook-trust.probe.json"), JSON.stringify(found, null, 2))
        }
      })
    },
  )
}
