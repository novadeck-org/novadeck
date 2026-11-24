import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { AgentName } from "@novadeck/protocol"

import type { AgentSetup } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported, type E2E } from "./fixture.js"
import { prompted } from "./scenarios.js"
import { claudeHello, openssl, standIn } from "./stand-in.js"

// What holds each harness for the person before Novadeck can reach it, as
// `TerminalSummary.startup` says (docs/agent-messaging.md, "Startup screens"): its sign-in
// screen, or its prompt saying it isn't signed in, and Novadeck's hooks not running for it,
// untrusted (Codex) or off in the person's own settings (Claude Code, Antigravity). Each
// harness has both; the way the person gets there differs, as each case says. Each holds
// alike where Novadeck opened the agent and where the person typed it in a plain shell.

/**
 * How the agent starts: Novadeck opens it, the person types it in a shell of its own, or they
 * type a script of their own that starts it, which no platform names after the agent. Typed
 * either way, Novadeck's shim tells Novadeck as it starts the session, which is all that
 * names a typed agent on Windows (ConPTY tells only the shell) and a scripted one anywhere.
 */
const launches = ["opened", "typed", "scripted"] as const
type Launch = (typeof launches)[number]

const launch = async (run: E2E, how: Launch, command: string): Promise<DeckTerminal> => {
  if (how === "opened") return run.deck.open(command)
  const terminal = await run.deck.open()
  await terminal.submit(command)
  return terminal
}

const typed = (how: Launch): string =>
  how === "typed"
    ? ", typed in its shell"
    : how === "scripted"
      ? ", started by a script typed in its shell"
      : ""

/**
 * A program that starts the agent on PATH with its environment changed: each of `env` set, or
 * unset where null. Opened, it is named after `agent`, so Novadeck expects it, and started by
 * its full path; typed, it lies in the project and is typed by a short relative one, as a
 * long path wraps on a narrow screen and its echo can't be told whole. Scripted, it is named
 * as the person's own (`my-<agent>`) and starts the agent as its child, so the terminal's
 * foreground program is the script.
 */
const wrapped = async (
  run: E2E,
  how: Launch,
  agent: AgentName,
  env: Readonly<Record<string, string | null>>,
): Promise<string> => {
  const folder =
    how === "opened" ? join(run.sandbox.root, "wrapped") : join(run.sandbox.project, ".bare")
  const program = how === "scripted" ? `my-${agent}` : agent
  await mkdir(folder, { recursive: true })
  const entries = Object.entries(env)
  if (process.platform === "win32") {
    const script = join(folder, `${program}.cmd`)
    // A name is one to cmd whatever its case, yet the environment it was given may hold it
    // twice (the sandbox's HTTPS_PROXY and https_proxy): each is cleared before it is set.
    const names = new Map(entries.map(([name, value]) => [name.toUpperCase(), value]))
    const lines = [...names].flatMap(([name, value]) => [
      `@set "${name}="`,
      `@set "${name}="`,
      ...(value === null ? [] : [`@set "${name}=${value}"`]),
    ])
    await writeFile(script, [...lines, `@call ${agent} %*`, ""].join("\r\n"))
    return how === "opened" ? script : `.bare\\${program}`
  }
  const script = join(folder, program)
  const lines = entries.map(([name, value]) =>
    value === null ? `unset ${name}` : `export ${name}='${value.replaceAll("'", "'\\''")}'`,
  )
  const start = how === "scripted" ? `${agent} "$@"` : `exec ${agent} "$@"`
  await writeFile(script, ["#!/bin/sh", ...lines, start, ""].join("\n"), {
    mode: 0o755,
  })
  return how === "opened" ? script : `.bare/${program}`
}

const held = (terminal: DeckTerminal, why: string) =>
  terminal.poll(() => terminal.summary().startup ?? undefined, why, 60_000)

const readJson = async (path: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

const merge = async (path: string, change: (json: Record<string, unknown>) => void) => {
  const json = await readJson(path)
  change(json)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, JSON.stringify(json))
}

/**
 * Novadeck's hooks off for the harness, as the person may leave them: Codex's untrusted, its
 * review skipped (the seed leaves them so); Claude Code's turned off in the person's settings;
 * Antigravity's plugin disabled, as `agy plugin disable` records it. Read, never written,
 * by Novadeck: here the test plays the person.
 */
const hooksOff: { readonly [agent in AgentName]: (run: E2E) => Promise<void> } = {
  codex: async () => {},
  claude: (run) =>
    merge(join(run.sandbox.home, ".claude", "settings.json"), (settings) => {
      settings.disableAllHooks = true
    }),
  agy: (run) =>
    merge(join(run.sandbox.home, ".gemini", "config", "config.json"), (config) => {
      config.plugins = {
        ...(config.plugins as object | undefined),
        novadeck: { enabled: false },
      }
    }),
  // The setup's seed turns its plugin off for the launch (OPENCODE_PURE), the one way a
  // person's launch can leave it unloaded without a file of theirs.
  opencode: async () => {},
}

for (const setup of setups) {
  describe.skipIf(!supported)(`${setup.name}, Novadeck's hooks off`, () => {
    for (const how of launches)
      e2e.seeded({ hooksTrusted: false }, setup)(
        `reads as held by them at its prompt, and at its review where it has one${typed(how)}`,
        async ({ e2e: run }) => {
          await hooksOff[setup.agent](run)
          const t = await launch(
            run,
            how,
            how === "scripted" ? await wrapped(run, how, setup.agent, {}) : setup.agent,
          )
          const review = setup.trust?.hooks
          if (review) {
            await t.until(review.shows, 60_000)
            await held(t, "its hooks review to count")
            expect(t.summary().startup).toEqual({ agent: setup.agent, screen: "hooks" })
            await skip(t, review)
          }
          // Its own prompt, with nothing of Novadeck's running for it.
          await prompted(t, setup)
          await t.poll(
            () => (t.summary().startup?.screen === "hooks" ? true : undefined),
            "its hooks to be found off at its prompt",
            60_000,
          )
          expect(t.summary()).toMatchObject({
            agent: null,
            ready: null,
            startup: { agent: setup.agent, screen: "hooks" },
          })
          // It stays so: nothing binds there.
          await sleep(3000)
          expect(t.summary().startup).toEqual({ agent: setup.agent, screen: "hooks" })
        },
      )

    if (setup.agent === "claude")
      e2e(setup)(
        "reads as held where the project's settings turn the plugin off",
        async ({ e2e: run }) => {
          await merge(join(run.sandbox.project, ".claude", "settings.json"), (settings) => {
            settings.enabledPlugins = { "novadeck@novadeck": false }
          })
          const t = await run.deck.open(setup.agent)
          await t.poll(
            () => (t.summary().startup?.screen === "hooks" ? true : undefined),
            "its hooks to be found off at its prompt",
            60_000,
          )
          expect(t.summary().startup).toEqual({ agent: "claude", screen: "hooks" })
        },
      )
  })

  describe.skipIf(!supported)(`${setup.name}, signed out`, () => {
    for (const how of launches) signedOut[setup.agent](setup, how)
  })
}

/** Leaves its hooks review without trusting them, Escape by Escape until it is gone. */
const skip = async (
  terminal: DeckTerminal,
  { shows, skip: keys }: { readonly shows: RegExp; readonly skip: string },
): Promise<void> => {
  for (let tries = 0; tries < 10; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each look waits on the key before.
    await terminal.escape(keys)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(1000)
    // eslint-disable-next-line no-await-in-loop -- As above.
    if (!shows.test(await terminal.screen())) return
  }
  throw new Error(`${terminal.handle} still shows ${String(shows)}`)
}

/**
 * Each harness without a login: the screen it signs in at, and Claude Code's prompt, which
 * says it isn't signed in once its onboarding is done.
 */
const signedOut: {
  readonly [agent in AgentName]: (setup: AgentSetup, how: Launch) => void
} = {
  claude: (setup, how) => {
    // Bound, it is found by its session however it started.
    if (how !== "scripted")
      e2e(setup)(
        `reads its prompt saying it isn't signed in as waiting to sign in${typed(how)}`,
        async ({ e2e: run }) => {
          const t = await launch(
            run,
            how,
            await wrapped(run, how, "claude", { ANTHROPIC_API_KEY: null }),
          )
          await t.until(/Not logged in · [Rr]un \/login/, 60_000)
          await held(t, "its prompt to read as signed out")
          // A session bound, at a prompt whose first prompt would fail.
          expect(t.summary()).toMatchObject({
            agent: "claude",
            startup: { agent: "claude", screen: "sign-in" },
          })
        },
      )

    // Its sign-in screen comes only at a first run, past a connectivity check the sandbox
    // refuses: a stand-in answers it, under a scratch authority only this Claude Code trusts.
    // Opened only: typed, it is the same screen the same watch names.
    if (how === "opened")
      gated(
        e2e(setup),
        openssl() ? undefined : "no openssl here to make the stand-in's certificate",
      )("names its sign-in screen at a first run", async ({ e2e: run }) => {
        await merge(join(run.sandbox.home, ".claude", ".claude.json"), (state) => {
          delete state.hasCompletedOnboarding
          delete state.lastOnboardingVersion
          delete state.theme
        })
        const hello = await standIn(run.sandbox.root, claudeHello)
        try {
          const t = await run.deck.open(
            await wrapped(run, how, "claude", {
              ANTHROPIC_API_KEY: null,
              HTTPS_PROXY: hello.url,
              https_proxy: hello.url,
              NODE_EXTRA_CA_CERTS: hello.ca,
            }),
          )
          // Its theme picker comes first, which Enter takes as it is.
          await t.confirm(/Dark mode/, () => t.until(/Choose the text style/, 60_000))
          await t.until(/Select login method/, 60_000)
          await held(t, "its sign-in screen to count")
          expect(t.summary().startup).toEqual({ agent: "claude", screen: "sign-in" })
        } finally {
          hello.close()
        }
      })
  },
  // Without an OpenAI login, in a home of its own that names the fake model as its ChatGPT
  // backend, and keeps the sandbox's empty copy of the curated plugins: without one, Codex
  // fetches an archive of them from chatgpt.com, which the fake model's proxy refuses.
  codex: (setup, how) => {
    e2e(setup)(`names its sign-in screen${typed(how)}`, async ({ e2e: run }) => {
      const home = join(run.sandbox.home, ".codex-bare")
      await mkdir(home, { recursive: true })
      await writeFile(
        join(home, "config.toml"),
        `chatgpt_base_url = ${JSON.stringify(`${run.model.url}/backend-api/`)}\n` +
          'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n',
      )
      await cp(join(run.sandbox.home, ".codex", ".tmp"), join(home, ".tmp"), { recursive: true })
      const t = await launch(
        run,
        how,
        await wrapped(run, how, "codex", { OPENAI_API_KEY: null, CODEX_HOME: home }),
      )
      await t.until(/Sign in with ChatGPT/, 60_000)
      await held(t, "its sign-in screen to count")
      expect(t.summary().startup).toEqual({ agent: "codex", screen: "sign-in" })
    })
  },
  // Its status line says `authenticating` behind its login screen, and its text says so too.
  agy: (setup, how) => {
    e2e(setup)(`names its sign-in screen${typed(how)}`, async ({ e2e: run }) => {
      await merge(
        join(run.sandbox.home, ".gemini", "antigravity-cli", "settings.json"),
        (settings) => {
          delete settings.modelProvider
        },
      )
      const t = await launch(run, how, await wrapped(run, how, "agy", { GEMINI_API_KEY: null }))
      await t.until(/Select login method/, 60_000)
      await held(t, "its sign-in screen to count")
      expect(t.summary().startup).toEqual({ agent: "agy", screen: "sign-in" })
    })
  },
  // No screen of its own holds it before its prompt, signed in or not: a missing or refused
  // key shows only as its first turn's error (probed 2026-11-22, 1.19.6). Skipped by name, so
  // the suite isn't empty, which vitest fails.
  opencode: (setup, how) =>
    gated(
      e2e(setup),
      "it shows no sign-in screen: a missing or refused key is its first turn's error",
    )(`reads its sign-in screen as signed out${typed(how)}`, async () => {}),
}

// Which agent a terminal opened to run one starts (`TerminalSummary.expecting`), which the chat
// shows from the start: told from the open until the agent's prompt shows, and gone once the
// start comes to nothing, as a plain shell.
for (const setup of setups)
  describe.skipIf(!supported)(`${setup.name}, starting`, () => {
    e2e(setup)("says which agent starts until its prompt shows", async ({ e2e: run }) => {
      const t = await run.deck.open(setup.agent)
      expect(t.summary().expecting).toBe(setup.agent)
      await t.reached("ready", { timeoutMs: 60_000 })
      await prompted(t, setup)
      await t.poll(
        () => (t.summary().expecting === null ? true : undefined),
        "the start to be told over",
        10_000,
      )
    })

    e2e(setup)(
      "says which agent the person typed starts, from its shim's word",
      async ({ e2e: run }) => {
        const t = await run.deck.open()
        await t.submit(setup.agent)
        await t.poll(
          () => (t.summary().expecting === setup.agent ? true : undefined),
          "the typed agent's start to be told",
          30_000,
        )
        await t.reached("ready", { timeoutMs: 60_000 })
        await prompted(t, setup)
        await t.poll(
          () => (t.summary().expecting === null ? true : undefined),
          "the start to be told over",
          10_000,
        )
      },
    )

    e2e(setup)("says none once its start comes to nothing", async ({ e2e: run }) => {
      // A program named after the agent that exits at once, as a failed start does.
      const folder = join(run.sandbox.root, "failing")
      await mkdir(folder, { recursive: true })
      const windows = process.platform === "win32"
      const script = join(folder, windows ? `${setup.agent}.cmd` : setup.agent)
      await writeFile(script, windows ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      const t = await run.deck.open(script)
      expect(t.summary().expecting).toBe(setup.agent)
      await t.poll(
        () => (t.summary().expecting === null ? true : undefined),
        "the failed start to be told over",
        30_000,
      )
      expect(t.summary()).toMatchObject({ agent: null, ready: null, startup: null })
    })
  })
