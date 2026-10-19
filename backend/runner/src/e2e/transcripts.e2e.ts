/* eslint-disable no-await-in-loop -- A scenario's steps run in order, each after the one before. */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import type { TranscriptItem } from "@novadeck/protocol"

import type { AgentSetup } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool, type Call, type Reply } from "./model/script.js"
import { own, start } from "./scenarios.js"

// The chat's contract with each harness's transcript, the latest half (docs: the chat
// contract test). The pinned half replays recorded transcripts through the decoders; this
// one has each real harness call its own tools against the fake model and reads what the
// runner serves (`agents.transcript`). In the nightly `NOVADECK_E2E_HARNESS=latest` run it
// flags a release that renamed or reshaped a tool: the call then shows as `other`, or
// vanishes, or loses its result.

/** Where a failed test's raw transcript goes (`NOVADECK_E2E_TRACES`), as CI uploads it. */
const traces = process.env.NOVADECK_E2E_TRACES

type Kind = NonNullable<TranscriptItem["run"]>["kind"]

/** One tool call the fake model makes, and what the chat must make of it. */
type Step = {
  /** The reply that calls the tool, given the call it answers. */
  readonly reply: (call: Call) => Reply
  /** What the chat's line for the call says: its kind, and the start of its title. */
  readonly kinds: readonly Kind[]
  readonly title: RegExp
  /** Text only this call's input holds, which finds its item. */
  readonly marker: string
}

/** The steps of a harness, given the sandbox's project folder. */
type Steps = (project: string) => readonly Step[]

const message = "transcripts-contract-message"

/** Novadeck's own `send`, which every harness offers under its own prefix. */
const send: Step = {
  marker: message,
  kinds: ["agent"],
  title: /^Messaged/,
  reply: (call) => {
    const name = tool(call, "send")
    if (!name) throw new Error(`The harness offers no send tool: ${call.tools.join(", ")}`)
    return { calls: [{ name, input: { to: "fox", text: message } }] }
  },
}

const claudeSteps: Steps = (project) => [
  {
    marker: "transcripts-bash",
    kinds: ["run"],
    title: /^Ran$/,
    reply: () => ({
      calls: [
        {
          name: "Bash",
          input: {
            command: "echo transcripts-bash",
            description: "Prints a word",
          },
        },
      ],
    }),
  },
  {
    marker: "transcripts-read.txt",
    kinds: ["read"],
    title: /^Read$/,
    reply: () => ({
      calls: [
        {
          name: "Read",
          input: { file_path: join(project, "transcripts-read.txt") },
        },
      ],
    }),
  },
  {
    marker: "transcripts-write.txt",
    kinds: ["write"],
    title: /^Wrote$/,
    reply: () => ({
      calls: [
        {
          name: "Write",
          input: {
            file_path: join(project, "transcripts-write.txt"),
            content: "written\n",
          },
        },
      ],
    }),
  },
  send,
]

const codexSteps: Steps = () => [
  {
    marker: "transcripts-command",
    kinds: ["run"],
    title: /^Ran$/,
    reply: () => ({
      calls: [
        {
          name: "exec_command",
          input: { cmd: "echo transcripts-command", yield_time_ms: 10_000 },
        },
      ],
    }),
  },
  {
    // The fake model's Codex is offered no apply_patch tool, so it patches through its
    // shell with a heredoc (controls.e2e.ts). Today the rollout records it as the shell call
    // it is, which reads as a run; a newer Codex may record it as a patch, a write. Either
    // is fine: a failure here, then, may be an improvement that needs a new pinned fixture,
    // not a break. Only `other`, or a call without its result, is one.
    marker: "transcripts-patch.txt",
    kinds: ["run", "write"],
    title: /^(Ran|Patched)$/,
    reply: () => ({
      calls: [
        {
          name: "exec_command",
          input: {
            cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: transcripts-patch.txt\n+patched\n*** End Patch\nEOF",
            yield_time_ms: 10_000,
          },
        },
      ],
    }),
  },
  send,
]

// The folder its commands run in, as its system prompt names it: a command must run there
// (as agents/agy.ts does).
const workingDirectory = (call: Call): string => {
  const folder = /^Command Working Directory: (.+)$/m.exec(call.system)?.[1]
  if (!folder) throw new Error("Antigravity's system prompt names no command working directory")
  return folder
}

const agySteps: Steps = (project) => [
  {
    marker: "transcripts-command",
    kinds: ["run"],
    title: /^Ran$/,
    reply: (call) => ({
      calls: [
        {
          name: "run_command",
          input: {
            CommandLine: "echo transcripts-command",
            Cwd: workingDirectory(call),
            WaitMsBeforeAsync: 10_000,
            toolSummary: "Print a word",
            toolAction: "Running",
          },
        },
      ],
    }),
  },
  {
    marker: "transcripts-read.txt",
    kinds: ["read"],
    title: /^Read$/,
    reply: () => ({
      calls: [
        {
          name: "view_file",
          input: {
            AbsolutePath: join(project, "transcripts-read.txt"),
            toolSummary: "Read a file",
            toolAction: "Reading",
          },
        },
      ],
    }),
  },
  {
    marker: "transcripts-write.txt",
    kinds: ["write"],
    title: /^Wrote$/,
    reply: () => ({
      calls: [
        {
          name: "write_to_file",
          input: {
            TargetFile: join(project, "transcripts-write.txt"),
            Overwrite: true,
            CodeContent: "written\n",
            Description: "Writes the file",
            toolSummary: "Write",
            toolAction: "Writing",
          },
        },
      ],
    }),
  },
  send,
]

const stepsOf: Readonly<Record<AgentSetup["agent"], Steps>> = {
  claude: claudeSteps,
  codex: codexSteps,
  agy: agySteps,
}

/** Reads the root actor's transcript, or none yet: the agent has not opened it. */
const items = async (terminal: DeckTerminal): Promise<readonly TranscriptItem[]> => {
  try {
    return await terminal.transcript()
  } catch (error) {
    if ((error as { code?: string }).code === "NOT_FOUND") return []
    throw error
  }
}

/**
 * Lets the turn of `done` run to its end: whatever the harness asks the person before the
 * tool runs is allowed through the chat's answer, as the chat does.
 */
const allowing = (terminal: DeckTerminal, done: string): Promise<string> =>
  terminal.poll(
    async () => {
      const request = (await terminal.detail()).requests.find((each) => !each.answered)
      if (request?.dialog?.type === "choices") {
        const yes = request.dialog.options.find((each) => each.label.startsWith("Yes"))
        if (!yes) throw new Error(`No yes in ${JSON.stringify(request.dialog)}`)
        await terminal.answer(request.ref, {
          dialog: request.dialog.id,
          type: "choice",
          option: yes.id,
        })
      }
      const shown = await terminal.screen()
      return shown.includes(done) ? shown : undefined
    },
    `its turn to end with "${done}"`,
    60_000,
  )

/** The raw files under `folder` (a harness's own store) that hold `marker`, deepest last. */
const rawFiles = (folder: string, marker: string): string[] => {
  const found: string[] = []
  try {
    for (const name of readdirSync(folder, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (name.includes("subagents")) continue
      const path = join(folder, name)
      try {
        if (readFileSync(path, "utf8").includes(marker)) found.push(path)
      } catch {
        // A folder, or a file that cannot be read as text, holds no transcript.
      }
    }
  } catch {
    // The harness wrote no store yet.
  }
  return found
}

/**
 * Where each harness keeps the file its decoder reads (`transcripts.locate` answers with the
 * path its hooks name for the root, which is this file): Claude Code's session JSONL,
 * Codex's rollout, Antigravity's steps.
 */
const stores: Readonly<Record<AgentSetup["agent"], readonly string[]>> = {
  claude: [".claude/projects"],
  codex: [".codex/sessions"],
  agy: [".gemini/antigravity-cli/brain", ".gemini/antigravity-cli/conversations"],
}

/** Copies the raw transcript of the run to `NOVADECK_E2E_TRACES`, the next pinned fixture. */
const keep = (setup: AgentSetup, home: string, marker: string): void => {
  if (!traces) return
  mkdirSync(traces, { recursive: true })
  const files = stores[setup.agent].flatMap((store) => rawFiles(join(home, store), marker))
  for (const file of files)
    copyFileSync(file, join(traces, `transcripts-${setup.agent}-raw-${basename(file)}`))
  if (files.length === 0)
    writeFileSync(
      join(traces, `transcripts-${setup.agent}-raw-missing.txt`),
      `No raw transcript holding ${marker} under ${stores[setup.agent].join(", ")} of ${home}\n`,
    )
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("serves every tool call its harness made as a classified call paired with its result", async ({
      e2e: run,
    }) => {
      const steps = stepsOf[setup.agent](run.sandbox.project)
      const tag = (index: number): string => `Transcript step ${index + 1}`
      writeFileSync(join(run.sandbox.project, "transcripts-read.txt"), "read me\n")
      run.model.use(
        ...steps.flatMap((step, index) => [
          own((call) => (asked(call, tag(index)) ? step.reply(call) : undefined)),
          own((call) => {
            // A tool's result after the latest step's prompt, the model not having answered
            // since: a user text beside the result doesn't hide it.
            const prompt = call.turns.findLastIndex(
              (turn) => turn.role === "user" && turn.text.includes("Transcript step "),
            )
            const answered = call.turns.findLastIndex((turn) => turn.role === "assistant")
            const resulted = call.turns.findLastIndex((turn) => turn.role === "tool")
            return prompt > -1 &&
              call.turns[prompt]!.text.includes(tag(index)) &&
              resulted > prompt &&
              resulted > answered
              ? { text: `Finished ${tag(index)}.` }
              : undefined
          }),
        ]),
      )
      // The sandbox is gone by the time `onTestFailed` runs, so the raw file is kept here.
      try {
        // The recipient of the `send`, which only has to exist.
        const t1 = await start(run, setup)
        await start(run, setup)
        for (const [index] of steps.entries()) {
          const began = Date.now()
          await t1.prompt(tag(index))
          await allowing(t1, `Finished ${tag(index)}.`)
          // The next prompt is refused while the turn or a request is pending: Codex's shell
          // patch settles only through its rollout, a moment behind the hooks.
          // Its turn ended after the prompt. The delivery state isn't waited on: a request
          // the chat answered leaves it Drafting, as the keys it pressed look typed.
          await t1.poll(
            () => {
              const last = t1.summary().activity?.lastTurn
              return last?.outcome === "completed" && last.at >= began ? true : undefined
            },
            "its turn to be recorded as completed",
            30_000,
          )
          await t1.poll(
            async () => ((await t1.detail()).requests.length === 0 ? true : undefined),
            "its requests to be settled",
            15_000,
          )
        }

        // The rollout or transcript is read a moment behind the screen: wait for every
        // scripted call to be served with its result, then assert on that.
        const served = await t1
          .poll(
            async () => {
              const all = await items(t1)
              const done = steps.every((step) => {
                const call = all.find(
                  (one) => one.kind === "tool-call" && one.text.includes(step.marker),
                )
                return (
                  call?.call != null &&
                  all.some((one) => one.kind === "tool-result" && one.call === call.call)
                )
              })
              return done ? all : undefined
            },
            "every scripted call to be served with its result",
            30_000,
          )
          .catch(async (error: unknown) => {
            const all = await items(t1)
            throw new Error(
              `${String(error)}\nServed: ${JSON.stringify(
                all.map(({ kind, tool: name, run: what, call }) => ({
                  kind,
                  name,
                  what,
                  call,
                })),
              )}`,
              { cause: error },
            )
          })

        const calls = served.filter((one) => one.kind === "tool-call")
        // Never passes on an empty transcript: at least the scripted calls are there.
        expect(calls.length).toBeGreaterThanOrEqual(steps.length)
        for (const step of steps) {
          const call = calls.find((one) => one.text.includes(step.marker))
          expect(call, `the call holding ${step.marker}`).toBeDefined()
          expect(call!.run, `${call!.tool}: ${call!.text}`).not.toBeNull()
          expect(call!.run!.kind).not.toBe("other")
          expect(step.kinds, `${call!.tool}: ${JSON.stringify(call!.run)}`).toContain(
            call!.run!.kind,
          )
          expect(call!.run!.title).toMatch(step.title)
          const results = served.filter(
            (one) => one.kind === "tool-result" && one.call === call!.call,
          )
          expect(results, `the result of ${call!.tool}`).toHaveLength(1)
        }
      } catch (error) {
        try {
          keep(setup, run.sandbox.home, tag(0))
        } catch (copying) {
          // The failure to report is the test's own.
          console.error("The raw transcript could not be kept:", copying)
        }
        throw error
      }
    })
  })
}
