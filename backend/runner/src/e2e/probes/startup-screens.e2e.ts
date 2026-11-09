// PROBE, not a test of Novadeck: what each harness's screens look like from the moment its
// command is entered until its prompt or a question that holds it, for #521. Each case is
// sampled for a while: every distinct screen, when it came, how the harness's own box reads
// it, the foreground program, and the row of the shell's latest prompt. Runs only with
// NOVADECK_E2E_PROBES=1 and PROBE_OUT set, by path; writes $PROBE_OUT/<harness>-<case>.json,
// which `harnesses/<harness>/src/fixtures/startup.probe.json` keeps the last screen of. Codex's
// sign-in case runs in a home of its own, which keeps the sandbox's empty copy of the curated
// plugins (without one, Codex fetches an archive of them from chatgpt.com, which the fake
// model's proxy refuses) and names the fake model as its ChatGPT backend; its update and slow-MCP cases quit Codex once they have watched, as Codex
// ends the servers it started only when it exits, and the deck's teardown (a hangup, then a
// kill) leaves the `sleep` of the slow server behind. With an update to offer, Codex also
// starts a managed app server and its updater, which stay after it exits: the update case
// ends them by their pid files.
// Claude Code without
// a key stops at its connectivity check before its sign-in screen, and nothing here raises an
// update screen of its, so neither is probed. With PROBE_RESUME_TURNS set too, each harness
// plays that many turns of PROBE_RESUME_KB kB against the fake model, so each writes its own
// format, and is restored by a restarted runner, as an app restart does; $PROBE_OUT then has
// <harness>-resume-<turns>x<kB>k.json, its `size` the largest files of the session.
/* eslint-disable no-await-in-loop -- Samples run in order. */
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { harnesses } from "../../harnesses/registry.js"
import type { AgentSetup } from "../agents/agent.js"
import { agy } from "../agents/agy.js"
import { claude } from "../agents/claude.js"
import { codex } from "../agents/codex.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, selected, supported, type E2E } from "../fixture.js"
import { installHarness } from "../install.js"
import { asked } from "../model/script.js"
import { own, replies, start } from "../scenarios.js"
import { sleep } from "./support.js"

const out = process.env.PROBE_OUT
const sampleMs = 200
const watchMs = Number(process.env.PROBE_WATCH_MS ?? 15_000)

type Inside = {
  records: Map<
    string,
    {
      prompts: { line: number }[]
      summary: {
        process: { name: string } | null
        ready: string | null
        startup: unknown
      }
      expecting: string | null
      startupScreen?: unknown
      bound: unknown
      terminal: { screen: { buffer: { active: { viewportY: number; baseY: number } } } }
    }
  >
}

const watch = async (
  run: E2E,
  setup: AgentSetup,
  terminal: DeckTerminal,
  name: string,
): Promise<void> => {
  const box = harnesses[setup.agent].box
  const inside = run.deck.terminals as unknown as Inside
  const started = Date.now()
  const seen: unknown[] = []
  let last: string | undefined
  while (Date.now() - started < watchMs) {
    const shown = await terminal.screenText()
    const record = inside.records.get(terminal.id)
    if (shown) {
      const text = `${shown.rows.join("\n")}${JSON.stringify(record?.summary.startup)}`
      if (text !== last) {
        last = text
        const read = box?.read(shown)
        seen.push({
          ms: Date.now() - started,
          read: read ? { mode: read.mode, text: read.text } : null,
          overlay: box?.overlay(shown) ?? null,
          process: record?.summary.process?.name ?? null,
          ready: record?.summary.ready ?? null,
          startup: record?.summary.startup ?? null,
          startupScreen: record?.startupScreen ?? null,
          bound: Boolean(record?.bound),
          expecting: record?.expecting ?? null,
          promptLines: record?.prompts.map((one) => one.line) ?? [],
          base: record?.terminal.screen.buffer.active.baseY ?? null,
          cursor: shown.cursor,
          alternate: shown.alternate,
          bracketedPaste: shown.bracketedPaste,
          screen: screenRecord(shown),
        })
      }
    }
    await sleep(sampleMs)
  }
  mkdirSync(out!, { recursive: true })
  writeFileSync(join(out!, `${name}.json`), JSON.stringify(seen, null, 1))
}

const trusted = { folderTrusted: true }

/** Quits what the terminal runs with Ctrl-C, and waits for its shell, so it ends what it started. */
const quit = async (run: E2E, terminal: DeckTerminal): Promise<void> => {
  const inside = run.deck.terminals as unknown as Inside
  const started = Date.now()
  while (inside.records.get(terminal.id)?.summary.process?.name !== "bash") {
    if (Date.now() - started > 20_000) throw new Error("Codex didn't quit on Ctrl-C")
    terminal.press("\x03")
    await sleep(1000)
  }
}

const resumeTurns = Number(process.env.PROBE_RESUME_TURNS ?? 0)
const resumeKb = Number(process.env.PROBE_RESUME_KB ?? 1)

/** The largest files under `folder`, largest first, as what a session's size is read from. */
const largest = (folder: string): { file: string; bytes: number }[] =>
  readdirSync(folder, { recursive: true, encoding: "utf8" })
    .flatMap((file) => {
      const stat = statSync(join(folder, file), { throwIfNoEntry: false })
      return stat?.isFile() ? [{ file, bytes: stat.size }] : []
    })
    .toSorted((one, other) => other.bytes - one.bytes)
    .slice(0, 4)

describe.skipIf(!out || !supported)("probe: startup screens", () => {
  describe.skipIf(!resumeTurns)("resume", () => {
    for (const setup of [claude, codex, agy])
      describe.skipIf(!selected(setup))(setup.agent, () => {
        e2e.seeded(trusted, setup)(
          `${resumeTurns} turns of ${resumeKb} kB`,
          async ({ e2e: run }) => {
            const line = "A line of the large session's reply, long enough to wrap in a terminal"
            const reply = Array.from(
              { length: Math.ceil((resumeKb * 1024) / (line.length + 8)) },
              (_, index) => `${index} ${line}.`,
            ).join("\n")
            run.model.use(
              own((call) => (asked(call, "of the large session") ? { text: reply } : undefined)),
            )
            const terminal = await start(run, setup)
            for (let turn = 1; turn <= resumeTurns; turn += 1) {
              const mark = terminal.mark()
              await terminal.submit(`Turn ${turn} of the large session`)
              await terminal.reached("settled", { after: mark, timeoutMs: 120_000 })
            }
            const name = `${setup.agent}-resume-${resumeTurns}x${resumeKb}k`
            mkdirSync(out!, { recursive: true })
            writeFileSync(
              join(out!, `${name}.size.json`),
              JSON.stringify(largest(run.sandbox.home)),
            )
            await run.deck.restart()
            await watch(run, setup, await run.deck.restore(terminal, { resume: setup.agent }), name)
          },
          Number(process.env.PROBE_RESUME_MS ?? 600_000),
        )
      })
  })
  describe.skipIf(!selected(claude))("claude", () => {
    e2e.seeded({ folderTrusted: false }, claude)("trust", async ({ e2e: run }) => {
      await watch(run, claude, await run.deck.open("claude"), "claude-trust")
    })
    e2e.seeded(trusted, claude)("ready", async ({ e2e: run }) => {
      await watch(run, claude, await run.deck.open("claude"), "claude-ready")
    })
    e2e.seeded(trusted, claude)("onboarding", async ({ e2e: run }) => {
      const file = join(run.sandbox.home, ".claude", ".claude.json")
      const state = JSON.parse(readFileSync(file, "utf8"))
      delete state.hasCompletedOnboarding
      delete state.lastOnboardingVersion
      delete state.theme
      writeFileSync(file, JSON.stringify(state))
      await watch(run, claude, await run.deck.open("claude"), "claude-onboarding")
    })
    e2e.seeded(trusted, claude)("mcp slow", async ({ e2e: run }) => {
      const file = join(run.sandbox.home, ".claude", ".claude.json")
      const state = JSON.parse(readFileSync(file, "utf8"))
      state.mcpServers = { slow: { command: "sleep", args: ["30"] } }
      writeFileSync(file, JSON.stringify(state))
      await watch(run, claude, await run.deck.open("claude"), "claude-mcp")
    })
    e2e.seeded(trusted, claude)("resume picker", async ({ e2e: run }) => {
      run.model.use(replies("Hello", "Hello."))
      const first = await run.deck.open("claude")
      await first.until(/❯/, 30_000)
      await first.submit("Hello")
      await sleep(4000)
      await watch(run, claude, await run.deck.open("claude --resume"), "claude-resume")
    })
  })

  describe.skipIf(!selected(codex))("codex", () => {
    e2e.seeded({ folderTrusted: false }, codex)("trust", async ({ e2e: run }) => {
      await watch(run, codex, await run.deck.open("codex"), "codex-trust")
    })
    e2e.seeded({ hooksTrusted: false }, codex)("hooks review", async ({ e2e: run }) => {
      await watch(run, codex, await run.deck.open("codex"), "codex-hooks")
    })
    e2e.seeded(trusted, codex)("ready", async ({ e2e: run }) => {
      await watch(run, codex, await run.deck.open("codex"), "codex-ready")
    })
    e2e.seeded(trusted, codex)("sign-in", async ({ e2e: run }) => {
      const home = join(run.sandbox.home, ".codex-bare")
      mkdirSync(home, { recursive: true })
      writeFileSync(
        join(home, "config.toml"),
        `chatgpt_base_url = ${JSON.stringify(`${run.model.url}/backend-api/`)}\n` +
          'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n',
      )
      // The sandbox's empty copy of the curated plugins: without one, Codex fetches an
      // archive of them from chatgpt.com, which the fake model's proxy refuses.
      cpSync(join(run.sandbox.home, ".codex", ".tmp"), join(home, ".tmp"), { recursive: true })
      const terminal = await run.deck.open(`env -u OPENAI_API_KEY CODEX_HOME=${home} codex`)
      await watch(run, codex, terminal, "codex-sign-in")
    })
    // Its update screen, read and never answered: no key reaches this terminal, and its PATH
    // holds no npm, so an accepted update could install nothing. It uses the sandbox's own
    // CODEX_HOME and the scratch install, and ends with the deck.
    e2e.seeded(trusted, codex)("update", async ({ e2e: run }) => {
      const home = join(run.sandbox.home, ".codex")
      const file = join(home, "config.toml")
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "check_for_update_on_startup = false",
          "check_for_update_on_startup = true",
        ),
      )
      writeFileSync(
        join(home, "version.json"),
        JSON.stringify({ latest_version: "99.0.0", last_checked_at: new Date().toISOString() }),
      )
      const { bin } = await installHarness("codex")
      const path = join(run.sandbox.root, "no-npm")
      mkdirSync(path)
      symlinkSync(process.execPath, join(path, "node"))
      symlinkSync(join(bin, "codex"), join(path, "codex"))
      symlinkSync("/usr/bin/ps", join(path, "ps"))
      const terminal = await run.deck.open(`env PATH=${path} codex`)
      await watch(run, codex, terminal, "codex-update")
      await quit(run, terminal)
      // The app server and updater it started, which a managed install keeps running after
      // the TUI exits: ended by the pids in its own files, in the sandbox's home.
      const daemon = join(home, "app-server-daemon")
      for (const pidFile of ["daemon.pid", "daemon-updater.pid"])
        try {
          process.kill(JSON.parse(readFileSync(join(daemon, pidFile), "utf8")).pid, "SIGTERM")
        } catch {
          // Not started, or gone already.
        }
      await sleep(1000)
    })
    e2e.seeded(trusted, codex)("mcp slow", async ({ e2e: run }) => {
      const file = join(run.sandbox.home, ".codex", "config.toml")
      appendFileSync(
        file,
        `\n[mcp_servers.slow]\ncommand = "sleep"\nargs = ["30"]\nstartup_timeout_sec = 30\n`,
      )
      const terminal = await run.deck.open("codex")
      await watch(run, codex, terminal, "codex-mcp")
      await quit(run, terminal)
    })
    e2e.seeded(trusted, codex)("resume picker", async ({ e2e: run }) => {
      await watch(run, codex, await run.deck.open("codex resume"), "codex-resume")
    })
  })

  describe.skipIf(!selected(agy))("agy", () => {
    e2e.seeded({ folderTrusted: false }, agy)("trust", async ({ e2e: run }) => {
      await watch(run, agy, await run.deck.open("agy"), "agy-trust")
    })
    e2e.seeded(trusted, agy)("ready", async ({ e2e: run }) => {
      await watch(run, agy, await run.deck.open("agy"), "agy-ready")
    })
    e2e.seeded(trusted, agy)("mcp slow", async ({ e2e: run }) => {
      writeFileSync(
        join(run.sandbox.home, ".gemini", "antigravity-cli", "mcp_config.json"),
        JSON.stringify({ mcpServers: { slow: { command: "sleep", args: ["30"] } } }),
      )
      await watch(run, agy, await run.deck.open("agy"), "agy-mcp")
    })
    e2e.seeded(trusted, agy)("onboarding", async ({ e2e: run }) => {
      const file = join(run.sandbox.home, ".gemini", "antigravity-cli", "settings.json")
      const state = JSON.parse(readFileSync(file, "utf8"))
      state.onboardingComplete = false
      writeFileSync(file, JSON.stringify(state))
      await watch(run, agy, await run.deck.open("agy"), "agy-onboarding")
    })
    e2e.seeded(trusted, agy)("sign-in", async ({ e2e: run }) => {
      const file = join(run.sandbox.home, ".gemini", "antigravity-cli", "settings.json")
      const { modelProvider: _modelProvider, ...state } = JSON.parse(readFileSync(file, "utf8"))
      writeFileSync(file, JSON.stringify(state))
      await watch(run, agy, await run.deck.open("env -u GEMINI_API_KEY agy"), "agy-sign-in")
    })
  })

  // A slow agent as the screen shows it: nothing drawn since the command was entered.
  describe("slow", () => {
    e2e.seeded(trusted, claude)("stand-in", async ({ e2e: run }) => {
      await watch(run, claude, await run.deck.open("sleep 9"), "slow-sleep")
    })
    for (const setup of [claude, codex, agy])
      e2e.seeded({ folderTrusted: false }, setup)(
        `${setup.agent}, slow to load`,
        async ({ e2e: run }) => {
          const wrapper = join(run.sandbox.project, setup.agent)
          writeFileSync(wrapper, `#!/bin/bash\necho Loading\nsleep 9\nexec ${setup.agent} "$@"\n`)
          chmodSync(wrapper, 0o755)
          await watch(run, setup, await run.deck.open(`./${setup.agent}`), `slow-${setup.agent}`)
        },
      )
    e2e.seeded(trusted, claude)("stand-in printing a line", async ({ e2e: run }) => {
      await watch(
        run,
        claude,
        await run.deck.open("bash -c 'sleep 3; echo Loading; sleep 6'"),
        "slow-line",
      )
    })
  })
})
