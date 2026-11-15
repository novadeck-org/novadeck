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
// Claude Code without a key shows its sign-in screen only at a first run, past a
// connectivity check the sandbox refuses (it then says so and exits), so that case answers
// the check through a stand-in (`stand-in.ts`); with onboarding done it starts to its prompt,
// which says it isn't signed in. Its update notices and Antigravity's updater, on, raise no
// screen: Antigravity's is told an update through a stand-in for its manifest, from a copy
// of its program, so nothing lands on the install. Claude Code's one update gate, a minimum
// version its feature flags name, prints and exits (read in its 2.1.316 program; a flag
// cached in its state didn't trigger it). The hooks-off cases turn Novadeck's hooks or
// plugin off in the person's settings, as they may. With PROBE_RESUME_TURNS set too, each harness
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
import { claudeHello, standIn } from "../stand-in.js"
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
        activity: unknown
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
          activity: record?.summary.activity ?? null,
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
    // Without a key, past its connectivity check: it asks `api.anthropic.com/api/hello` and
    // `platform.claude.com/v1/oauth/hello` for a 200, which a stand-in on loopback answers,
    // through a proxy of its own whose certificate a scratch authority signs.
    for (const fresh of [false, true])
      e2e.seeded(trusted, claude)(`sign-in${fresh ? " (fresh)" : ""}`, async ({ e2e: run }) => {
        const file = join(run.sandbox.home, ".claude", ".claude.json")
        if (fresh) {
          const state = JSON.parse(readFileSync(file, "utf8"))
          delete state.hasCompletedOnboarding
          delete state.lastOnboardingVersion
          delete state.theme
          writeFileSync(file, JSON.stringify(state))
        }
        const hello = await standIn(run.sandbox.root, claudeHello)
        try {
          // A command named claude, as Novadeck expects one there.
          const wrapper = join(run.sandbox.root, "claude")
          writeFileSync(
            wrapper,
            `#!/bin/sh\nexec env -u ANTHROPIC_API_KEY HTTPS_PROXY=${hello.url} https_proxy=${hello.url} NODE_EXTRA_CA_CERTS=${hello.ca} claude "$@"\n`,
            { mode: 0o755 },
          )
          const terminal = await run.deck.open(wrapper)
          // Its theme picker comes first, which Enter takes as it is.
          if (fresh) await terminal.confirm(/Dark mode/, async () => {})
          await watch(run, claude, terminal, `claude-sign-in${fresh ? "-fresh" : ""}`)
        } finally {
          hello.close()
        }
      })
    // Without a key, onboarding done: its prompt, a session bound, and a footer that says so;
    // then the person's first prompt there.
    e2e.seeded(trusted, claude)("signed out, prompted", async ({ e2e: run }) => {
      const wrapper = join(run.sandbox.root, "claude")
      writeFileSync(wrapper, '#!/bin/sh\nexec env -u ANTHROPIC_API_KEY claude "$@"\n', {
        mode: 0o755,
      })
      const terminal = await run.deck.open(wrapper)
      await terminal.until(/Not logged in/, 30_000)
      await sleep(2000)
      await terminal.submit("Hello")
      await watch(run, claude, terminal, "claude-signed-out-prompted")
    })
    // Without a key and with its connectivity check refused, as the sandbox refuses it.
    e2e.seeded(trusted, claude)("sign-in (offline)", async ({ e2e: run }) => {
      await watch(
        run,
        claude,
        await run.deck.open("env -u ANTHROPIC_API_KEY claude"),
        "claude-sign-in-offline",
      )
    })
    // Its update notices, with its updaters on: the sandbox refuses what they fetch.
    e2e.seeded(trusted, claude)("updater on", async ({ e2e: run }) => {
      const file = join(run.sandbox.home, ".claude", ".claude.json")
      const state = JSON.parse(readFileSync(file, "utf8"))
      state.autoUpdates = true
      writeFileSync(file, JSON.stringify(state))
      await watch(
        run,
        claude,
        await run.deck.open("env -u DISABLE_AUTOUPDATER -u DISABLE_UPDATES claude"),
        "claude-updater",
      )
    })
    // Novadeck's hooks installed but off: every hook, or its plugin in the project's settings.
    e2e.seeded(trusted, claude)("hooks disabled", async ({ e2e: run }) => {
      const file = join(run.sandbox.home, ".claude", "settings.json")
      const settings = JSON.parse(readFileSync(file, "utf8"))
      settings.disableAllHooks = true
      writeFileSync(file, JSON.stringify(settings))
      await watch(run, claude, await run.deck.open("claude"), "claude-hooks-disabled")
    })
    e2e.seeded(trusted, claude)("plugin disabled in the project", async ({ e2e: run }) => {
      mkdirSync(join(run.sandbox.project, ".claude"), { recursive: true })
      writeFileSync(
        join(run.sandbox.project, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { "novadeck@novadeck": false } }),
      )
      await watch(run, claude, await run.deck.open("claude"), "claude-plugin-disabled")
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
    // Its hooks review, then skipped with Esc: its prompt, with Novadeck's hooks off.
    e2e.seeded({ hooksTrusted: false }, codex)("hooks review skipped", async ({ e2e: run }) => {
      const terminal = await run.deck.open("codex")
      await terminal.until(/Hooks need review/, 30_000)
      await sleep(1000)
      terminal.press("\x1b")
      await watch(run, codex, terminal, "codex-hooks-skipped")
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
    // Its update screen, read and never accepted: its PATH
    // holds no npm, so an accepted update could install nothing. It uses the sandbox's own
    // CODEX_HOME and the scratch install, and ends with the deck.
    for (const launch of ["wrapped", "manual", "expected"] as const)
      e2e.seeded(trusted, codex)(`update (${launch})`, async ({ e2e: run }) => {
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
        const wrapper = join(run.sandbox.root, "codex")
        writeFileSync(wrapper, `#!/bin/sh\nexec env PATH="${path}" codex\n`, { mode: 0o755 })
        // A command named codex is expected; an env wrapper and a command typed into an
        // ordinary shell are not. All three must leave its startup screen reachable.
        const command = launch === "expected" ? wrapper : `env PATH=${path} codex`
        const terminal = await run.deck.open(launch === "manual" ? undefined : command)
        if (launch === "manual") await terminal.submit(command)
        await watch(run, codex, terminal, `codex-update-${launch}`)
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
    // What its updater left for the next start, in its own state file, and its updater on.
    for (const [name, status] of [
      ["update done", { success: true, message: "Updated to 99.0.0" }],
      ["update failed", { success: false, message: "Update failed, please install from website" }],
    ] as const)
      e2e.seeded(trusted, agy)(name, async ({ e2e: run }) => {
        const folder = join(run.sandbox.home, ".gemini", "antigravity-cli", "updater")
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, "update_status.json"), JSON.stringify(status))
        await watch(run, agy, await run.deck.open("agy"), `agy-${name.replace(" ", "-")}`)
      })
    // An update its updater finds, as its manifest names one, from a copy of it, so no
    // update lands on the installed program; the archive it names is never served.
    e2e.seeded(trusted, agy)("update found", async ({ e2e: run }) => {
      const { bin } = await installHarness("agy")
      const copy = join(run.sandbox.root, "agy-copy")
      mkdirSync(copy)
      cpSync(join(bin, "agy"), join(copy, "agy"))
      const hello = await standIn(
        run.sandbox.root,
        ["antigravity-cli-auto-updater-974169037036.us-central1.run.app", "storage.googleapis.com"],
        (path) =>
          path.startsWith("/manifests/")
            ? JSON.stringify({
                version: "99.0.0",
                url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/99.0.0/cli.tar.gz",
                sha512: "0".repeat(128),
              })
            : "{}",
      )
      try {
        const wrapper = join(run.sandbox.root, "agy")
        writeFileSync(
          wrapper,
          `#!/bin/sh\nexec env -u AGY_CLI_DISABLE_AUTO_UPDATE HTTPS_PROXY=${hello.url} https_proxy=${hello.url} SSL_CERT_FILE=${hello.ca} ${join(copy, "agy")} "$@"\n`,
          { mode: 0o755 },
        )
        await watch(run, agy, await run.deck.open(wrapper), "agy-update-found")
        const status = join(run.sandbox.home, ".gemini", "antigravity-cli", "updater")
        writeFileSync(
          join(out!, "agy-update-found.hits.json"),
          JSON.stringify({
            hits: hello.hits,
            status: readdirSync(status).map((file) => [
              file,
              readFileSync(join(status, file), "utf8"),
            ]),
          }),
        )
      } finally {
        hello.close()
      }
    })
    e2e.seeded(trusted, agy)("updater on", async ({ e2e: run }) => {
      await watch(
        run,
        agy,
        await run.deck.open("env -u AGY_CLI_DISABLE_AUTO_UPDATE agy"),
        "agy-updater",
      )
    })
    // Novadeck's plugin installed but disabled, as `agy plugin disable` records it.
    e2e.seeded(trusted, agy)("plugin disabled", async ({ e2e: run }) => {
      const file = join(run.sandbox.home, ".gemini", "config", "config.json")
      let config: { plugins?: Record<string, unknown> } = {}
      try {
        config = JSON.parse(readFileSync(file, "utf8"))
      } catch {
        // None yet.
      }
      config.plugins = { ...config.plugins, novadeck: { enabled: false } }
      writeFileSync(file, JSON.stringify(config))
      await watch(run, agy, await run.deck.open("agy"), "agy-plugin-disabled")
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
      // A command named agy, as Novadeck expects one there.
      const wrapper = join(run.sandbox.root, "agy")
      writeFileSync(wrapper, '#!/bin/sh\nexec env -u GEMINI_API_KEY agy "$@"\n', { mode: 0o755 })
      await watch(run, agy, await run.deck.open(wrapper), "agy-sign-in")
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
