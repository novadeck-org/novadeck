import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"

import { onTestFinished } from "vitest"

import type { AgentSetup } from "./agents/agent.js"
import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { installHarness } from "./install.js"
import { asked, record, tool, type Call, type Reply, type Rule } from "./model/script.js"
import { own, prompted, result } from "./scenarios.js"

// The person's grants (#587, #588) through Novadeck's own runner hooks, in each harness: a
// command the harness's own check stops (Claude Code's classifier in auto mode, Codex's and
// Antigravity's dialogs) runs unasked once the person approves an `approval` ask, and a near
// miss still doesn't. `gh` and `uberepo` are fake programs that write a marker file; nothing
// leaves the sandbox.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const granted = "gh pr ready 12 -R octo/repo"
const merge = "gh pr merge 12 -R octo/repo"
const grantedArgv = ["gh", "pr", "ready", "12", "-R", "octo/repo"]

type World = { readonly marker: string; readonly pwned: string; readonly readme: string }
const worlds = new Map<string, World>()

// The setup with fake `gh` and `uberepo` first on PATH, each appending its command line to the
// marker file.
const withFakes = (setup: AgentSetup): AgentSetup => ({
  ...setup,
  prepare: async (sandbox, model, installed, seed) => {
    const env = await setup.prepare(sandbox, model, installed, seed)
    const bin = join(sandbox.root, "fakebin")
    mkdirSync(bin, { recursive: true })
    const marker = join(sandbox.root, "ran.txt")
    for (const name of ["gh", "uberepo"]) {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\n[ "$1" = repo ] || echo "${name} $*" >> '${marker}'\n`,
      )
      chmodSync(join(bin, name), 0o755)
    }
    const readme = join(sandbox.project, "README.txt")
    writeFileSync(readme, "novadeck-approvals-readme\n")
    worlds.set(sandbox.root, { marker, pwned: join(sandbox.root, "pwned.txt"), readme })
    return { ...env, PATH: [bin, sandbox.env.PATH].join(delimiter) }
  },
})

// Claude Code in auto mode: its classifier is a model call of its own, scripted below to block.
const autoClaude: AgentSetup = {
  ...withFakes(claude),
  prepare: async (sandbox, model, installed, seed) => {
    const env = await withFakes(claude).prepare(sandbox, model, installed, seed)
    const config = join(sandbox.home, ".claude", "settings.json")
    const settings = JSON.parse(readFileSync(config, "utf8")) as {
      permissions: Record<string, unknown>
    }
    delete settings.permissions.disableAutoMode
    settings.permissions.defaultMode = "auto"
    writeFileSync(config, JSON.stringify(settings))
    // The gateway notice about classifier billing waits on Enter before the first classifier
    // call, which a teammate the test didn't type into can't be given; it is remembered once
    // acknowledged.
    const global = join(sandbox.home, ".claude", ".claude.json")
    writeFileSync(
      global,
      JSON.stringify({
        ...(JSON.parse(readFileSync(global, "utf8")) as object),
        autoModeClassifierBillingNoticeAcknowledgedAt: Date.now(),
      }),
    )
    return env
  },
}

type Kit = {
  readonly setup: AgentSetup
  /** The command line that starts the harness. */
  readonly command: string
  /** What the model calls to run `command` in the shell, outside the harness's sandbox. */
  readonly shell: (command: string) => Reply
  /** What the screen shows when the harness stopped the call. */
  readonly stopped: RegExp | undefined
  /** Else, what the model's next call carries as the call's result. */
  readonly denial?: RegExp
  /** The harness's own dialog for the call, and the keys that refuse it. */
  readonly dialog: RegExp
  readonly refuse: string
}

const kits: readonly Kit[] = [
  {
    setup: autoClaude,
    command: "claude --permission-mode auto",
    shell: (command) => ({
      calls: [{ name: "Bash", input: { command, description: "Run it" } }],
    }),
    // 2.1.304 shows nothing of a block but "Ran 1 shell command", so the model's result tells.
    stopped: undefined,
    denial: /denied by the Claude Code auto mode classifier/,
    dialog: /Hook PreToolUse:Bash requires confirmation/,
    refuse: "2",
  },
  {
    setup: withFakes(codex),
    command: "codex",
    shell: (command) => ({
      calls: [
        {
          name: "exec_command",
          input: {
            cmd: command,
            sandbox_permissions: "require_escalated",
            justification: "Run it outside the sandbox",
          },
        },
      ],
    }),
    stopped: /Would you like to run the following command\?/,
    dialog: /Would you like to run the following command\?/,
    refuse: "\x1b",
  },
  {
    setup: withFakes(agy),
    command: "agy",
    shell: (command) => ({
      calls: [
        {
          name: "run_command",
          input: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "Run it" },
        },
      ],
    }),
    stopped: /> 1\. Yes, run command/,
    dialog: /> 1\. Yes, run command/,
    refuse: "4",
  },
]

// What the classifier is told: block anything that touches `gh`. It is the one call with no
// tools, and its system prompt says what it is.
const classifies = (counted: { calls: number }): Rule => {
  return (call) => {
    if (!/You are a security monitor for autonomous AI coding agents/.test(call.system))
      return undefined
    counted.calls += 1
    const last = call.turns.at(-1)
    const said = last?.role === "user" ? last.text : ""
    const block = said.includes("gh pr")
    return {
      text: block
        ? "<severity>92</severity><category>External System Writes</category>"
        : "<severity>3</severity>",
    }
  }
}

// The ask tool with an `approval` shape. Antigravity loads an MCP tool's schema lazily, which
// the model reads first (see inbox.e2e.ts).
const approvalAsk = (call: Call): Reply | undefined => {
  const reading =
    call.turns.at(-1)?.role === "tool" &&
    call.turns
      .findLast((entry) => entry.role === "assistant")
      ?.calls.some(
        (entry) => entry.name === "read_file" && /[/\\]ask\.json$/.test(String(entry.input.Path)),
      ) === true
  if (asked(call, "get approval") && call.tools.includes("call_mcp_tool")) {
    const named = /directory `([^`]+)[/\\]<serverName>`/.exec(call.system)?.[1]
    if (!named) throw new Error("Antigravity named no MCP schema folder")
    const home = /^App Data Directory: (.+)$/m.exec(call.system)?.[1]?.trim()
    const folder =
      home && named.includes("<appDataDir>") ? named.replace("<appDataDir>", home) : named
    return {
      calls: [
        { name: "read_file", input: { Path: join(folder, "novadeck_novadeck", "ask.json") } },
      ],
    }
  }
  if (!asked(call, "get approval") && !reading) return undefined
  const name = tool(call, "ask")
  if (!name) throw new Error("Novadeck's ask tool is missing")
  return {
    calls: [
      {
        name,
        input: {
          subject: "May I run gh pr ready?",
          body: "I need to mark pull request 12 ready, and would like not to ask again.",
          hard_to_undo: "It tells the reviewers.",
          shape: {
            type: "approval",
            commands: [{ argv: grantedArgv, rest: false }],
          },
        },
      },
    ],
  }
}

const rules = (counted: { calls: number }, world: () => World): Rule[] => [
  classifies(counted),
  own((call) => {
    const ask = approvalAsk(call)
    if (ask) return ask
    const { pwned, readme } = world()
    if (asked(call, "run granted")) return shellFor(call, granted)
    if (asked(call, "run again")) return shellFor(call, granted)
    if (asked(call, "run merge")) return shellFor(call, merge)
    if (asked(call, "run padded"))
      return shellFor(call, `${granted}${" ".repeat(4100)}; touch ${pwned}`)
    if (asked(call, "run echo")) return shellFor(call, "echo hi > hi.txt")
    if (asked(call, "show readme"))
      return { calls: [{ name: "read_file", input: { Path: readme } }] }
    if (call.turns.at(-1)?.role === "tool") return { text: "Done." }
    return undefined
  }),
]

// Which harness a call is from, by the tools it offers.
const agentOf = (call: Call): string =>
  call.api === "anthropic" ? "claude" : call.api === "responses" ? "codex" : "agy"
const shellFor = (call: Call, command: string): Reply =>
  kits.find((kit) => kit.setup.agent === agentOf(call))!.shell(command)

const marks = (world: World): string[] =>
  existsSync(world.marker) ? readFileSync(world.marker, "utf8").split("\n").filter(Boolean) : []

/** Waits until `check` holds, clearing Claude Code's gateway notice, which waits on Enter. */
const until = async (
  terminal: DeckTerminal,
  what: string,
  check: (screen: string) => boolean,
  timeoutMs = 45_000,
): Promise<string> => {
  const end = Date.now() + timeoutMs
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- Polled in turn.
    const screen = await terminal.screen()
    if (check(screen)) return screen
    if (/Enter to continue · Esc to cancel/.test(screen)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- As above.
        await terminal.settled()
        terminal.enterEmpty()
      } catch {
        // The notice isn't Enter's to answer yet.
      }
    }
    if (Date.now() > end)
      throw new Error(`${what}: not seen in ${timeoutMs} ms; screen:\n${screen}`)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(250)
  }
}

/** Answers Claude Code's gateway notice, as it shows, until stopped. */
const clearing = (terminal: DeckTerminal): (() => void) => {
  const state = { going: true }
  void (async () => {
    while (state.going) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Polled in turn.
        if (/Enter to continue · Esc to cancel/.test(await terminal.screen())) {
          // eslint-disable-next-line no-await-in-loop -- As above.
          await terminal.settled()
          terminal.enterEmpty()
        }
      } catch {
        // The notice isn't Enter's to answer yet, or the terminal is gone.
      }
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(300)
    }
  })()
  return () => {
    state.going = false
  }
}

const open = async (run: E2E, kit: Kit): Promise<DeckTerminal> => {
  const terminal = await run.deck.open(kit.command)
  await terminal.reached("ready", { timeoutMs: 60_000 })
  await prompted(terminal, kit.setup)
  return terminal
}

describe.skipIf(!supported)("Approvals through Novadeck's runner hooks", () => {
  for (const kit of kits) {
    const { setup } = kit
    const it = e2e(setup)
    it(`${setup.name}: a grant lets the named command run unasked, and only that`, async ({
      e2e: run,
    }) => {
      const world = () => worlds.get(run.sandbox.root)!
      const counted = { calls: 0 }
      run.model.use(...rules(counted, world))
      // Antigravity takes a grant as launch settings from 1.4.10 on.
      const [major = 0, minor = 0, patch = 0] = (await installHarness(setup.agent)).version
        .split(".")
        .map(Number)
      const launched =
        setup.agent !== "agy" ||
        major > 1 ||
        (major === 1 && (minor > 4 || (minor === 4 && patch >= 10)))
      // The fake `gh` is a shell script. Codex's and Antigravity's own shells on macOS (a login
      // shell that puts the system's `gh` first) and on Windows (no `sh` script runs) may not
      // reach it, so there the marker proves nothing: the call's result reaching the model with
      // no dialog does.
      const marked = setup.agent === "claude" || process.platform === "linux"
      const ran = launched && marked ? 1 : 0
      let terminal = await open(run, kit)
      if (setup.agent === "claude") onTestFinished(clearing(terminal))
      const refuse = (shown: RegExp) => until(terminal, "the call stopped", (s) => shown.test(s))
      const stopped = async (label: string, before: number, mark: number) => {
        if (kit.stopped) await refuse(kit.stopped)
        else
          await run.model.waitFor((call) => kit.denial!.test(result(call) ?? ""), { after: mark })
        // Whatever the harness did, nothing ran.
        expect(marks(world()).length, label).toBe(before)
        expect(existsSync(world().pwned), label).toBe(false)
      }
      const dismiss = async () => {
        if (setup.agent === "claude") {
          // After the block the harness itself has nothing to dismiss.
          return
        }
        terminal.press(kit.refuse)
        await sleep(2500)
      }

      // 1. No grant: the harness's own check stops it.
      const markFirst = run.model.mark()
      await terminal.submit("run granted")
      await stopped("without a grant", 0, markFirst)
      await dismiss()

      // 1b. Claude Code, path B: the next identical try opens its own dialog, not the
      // classifier.
      if (setup.agent === "claude") {
        const classifiedBefore = counted.calls
        await terminal.submit("run again")
        await refuse(kit.dialog)
        expect(counted.calls, "the retry reached the classifier").toBe(classifiedBefore)
        expect(marks(world())).toEqual([])
        terminal.press(kit.refuse)
        await sleep(2500)
      }

      // 2. The agent asks to run it without asking again; the person approves in the Inbox.
      await until(terminal, "the prompt box", (s) => /❯|>|›/.test(s))
      await terminal.submit("get approval")
      const entry = await (async () => {
        const end = Date.now() + 45_000
        for (;;) {
          const found = run.deck.terminals
            .inboxEntries()
            .find((each) => each.content.kind === "ask" && each.terminalId === terminal.id)
          if (found) return found
          if (Date.now() > end) throw new Error("no approval ask in the Inbox")
          // eslint-disable-next-line no-await-in-loop -- Polled in turn.
          await sleep(250)
        }
      })()
      expect(record(record(entry.content).ask).shape).toMatchObject({ type: "approval" })
      run.deck.terminals.answerAsk(entry.id, { type: "approve" })
      await sleep(2000)

      // Antigravity takes a grant as launch settings, so its terminal starts again.
      if (setup.agent === "agy") {
        await run.deck.restart()
        terminal = await run.deck.restore(terminal, { resume: "agy" })
        await terminal.reached("ready", { timeoutMs: 60_000 })
        await prompted(terminal, setup)
      }

      // 3. The same command now runs with no dialog, and the classifier isn't asked. Antigravity
      // before 1.4.10 takes no launch grant: it restarts fine, its grant delivery says so, and
      // the command still gets its dialog.
      const classified = counted.calls
      const markAgain = run.model.mark()
      await terminal.submit("run again")
      if (launched) {
        if (marked) {
          const end = Date.now() + 45_000
          while (marks(world()).length === 0 && Date.now() < end) {
            // eslint-disable-next-line no-await-in-loop -- Polled in turn.
            await sleep(250)
          }
          expect(marks(world())).toEqual([`gh ${granted.slice(3)}`])
        } else {
          await run.model.waitFor((call) => call.turns.at(-1)?.role === "tool", {
            after: markAgain,
          })
        }
        expect(await terminal.screen()).not.toMatch(kit.dialog)
        expect(counted.calls, "the granted call reached the classifier").toBe(classified)
      } else {
        await until(terminal, "the dialog", (shown) => kit.dialog.test(shown))
        expect(marks(world())).toEqual([])
        const text = run.model.calls
          .flatMap((call) => call.turns.map((turn) => turn.text))
          .join("\n")
        expect(text).toContain("<grant")
        expect(text).toContain("before 1.4.10 never takes it")
        terminal.press(kit.refuse)
        await sleep(2500)
      }

      // 4. Near misses are not let through: another subcommand, and the same command padded
      // past 4096 characters before a second command.
      const markMerge = run.model.mark()
      await terminal.submit("run merge")
      await stopped("merge", ran, markMerge)
      await dismiss()
      const markPadded = run.model.mark()
      await terminal.submit("run padded")
      await stopped("padded", ran, markPadded)
      await dismiss()

      // 5. Antigravity: another program asks as before, and a file read doesn't ask at all.
      if (setup.agent === "agy") {
        const markEcho = run.model.mark()
        await terminal.submit("run echo")
        await stopped("echo", ran, markEcho)
        await dismiss()
        await terminal.submit("show readme")
        await run.model.waitFor(
          (call) => result(call)?.includes("novadeck-approvals-readme") === true,
        )
        expect(await terminal.screen()).not.toMatch(kit.dialog)
      }
    })
  }
})

// A lead's `propose_grant`, the person's Grant on its card, then a teammate the lead opens runs
// the granted command unasked while a merge is still stopped (Claude Code, auto mode).
describe.skipIf(!supported)("Approvals: a team grant", () => {
  const kit = kits[0]!
  const it = e2e(kit.setup)

  /**
   * A lead proposes the `pr` preset, the person grants it, and the lead opens a teammate whose
   * brief has it run `steps` in turn. Returns once the teammate has run its first step.
   */
  const team = async (run: E2E, counted: { calls: number }, steps: readonly string[]) => {
    // The Grant card offers the GitHub repos of the git repos under the project folder.
    const repo = join(run.sandbox.project, "repo")
    mkdirSync(repo, { recursive: true })
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", "https://github.com/octo/repo.git"],
    ])
      spawnSync("git", args, { cwd: repo })
    const brief = "tm-brief: mark the pull request ready, then try the rest"
    run.model.use(
      classifies(counted),
      own((call) => {
        if (asked(call, "propose it")) {
          const name = tool(call, "propose_grant")
          if (!name) throw new Error("Novadeck's propose_grant tool is missing")
          return {
            calls: [
              {
                name,
                input: { presets: ["pr"], reason: "Open and ready pull requests for octo/repo" },
              },
            ],
          }
        }
        if (asked(call, "open the teammate")) {
          const name = tool(call, "open_agent")
          if (!name) throw new Error("Novadeck's open_agent tool is missing")
          return { calls: [{ name, input: { agent: "claude", message: brief } }] }
        }
        const mine = call.turns.some(
          (turn) => turn.role === "user" && turn.text.includes("tm-brief"),
        )
        if (mine) {
          const runs = call.turns.filter(
            (turn) => turn.role === "assistant" && turn.calls.some((one) => one.name === "Bash"),
          ).length
          if (runs === 0) return kit.shell(steps[0]!)
          if (call.turns.at(-1)?.role === "tool")
            return runs < steps.length ? kit.shell(steps[runs]!) : { text: "Teammate done." }
        }
        if (call.turns.at(-1)?.role === "tool") return { text: "Done." }
        return undefined
      }),
    )
    const requests = run.deck.answerRequests()
    const lead = await open(run, kit)
    onTestFinished(clearing(lead))
    await lead.submit("propose it")
    const card = await (async () => {
      const end = Date.now() + 45_000
      for (;;) {
        const found = run.deck.terminals
          .inboxEntries()
          .find((each) => each.content.kind === "grant" && each.terminalId === lead.id)
        if (found) return found
        if (Date.now() > end) throw new Error("no Grant card in the Inbox")
        // eslint-disable-next-line no-await-in-loop -- Polled in turn.
        await sleep(250)
      }
    })()
    const proposal = record(record(card.content).proposal)
    expect(JSON.stringify(proposal.repos)).toContain("github.com/octo/repo")
    run.deck.terminals.answerAsk(card.id, {
      type: "grant",
      presets: ["pr"],
      commands: [],
      repos: ["github.com/octo/repo"],
      withLead: false,
      hours: 8,
    })
    await sleep(2000)

    await lead.submit("open the teammate")
    const teammate = await requests.next(60_000)
    onTestFinished(clearing(teammate))
  }

  it("Claude Code: a lead's grant covers the teammate it opens", async ({ e2e: run }) => {
    const world = () => worlds.get(run.sandbox.root)!
    await team(run, { calls: 0 }, [granted, merge])
    const mark = run.model.mark()
    await run.model.waitFor((call) => kit.denial!.test(result(call) ?? ""), {
      after: mark,
      timeoutMs: 90_000,
    })
    // The ready ran, unasked; the merge was blocked and left no mark.
    expect(marks(world())).toEqual([`gh ${granted.slice(3)}`])
    expect(existsSync(world().pwned)).toBe(false)
  })

  // The pr preset's --body-file (#615): a file inside the project is read by `gh`, so it runs
  // unasked; one outside it is stopped.
  it("Claude Code: --body-file inside the project runs under a pr grant, outside it is stopped", async ({
    e2e: run,
  }) => {
    const world = () => worlds.get(run.sandbox.root)!
    mkdirSync(join(run.sandbox.project, "notes"), { recursive: true })
    writeFileSync(join(run.sandbox.project, "notes", "body.md"), "A body.\n")
    const outside = join(run.sandbox.root, "outside.md")
    writeFileSync(outside, "Not in the project.\n")
    const inside = "gh pr comment 12 -R octo/repo --body-file notes/body.md"
    await team(run, { calls: 0 }, [inside, `gh pr comment 12 -R octo/repo --body-file ${outside}`])
    const mark = run.model.mark()
    await run.model.waitFor((call) => kit.denial!.test(result(call) ?? ""), {
      after: mark,
      timeoutMs: 90_000,
    })
    expect(marks(world())).toEqual([inside])
    expect(existsSync(world().pwned)).toBe(false)
  })
})
