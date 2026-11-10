import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ToolOutcome } from "@novadeck/protocol"

import type { AgentSetup } from "./agents/agent.js"
import { catalog } from "./agents/codex.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import type { E2E } from "./fixture.js"
import type { Call, Reply } from "./model/script.js"
import { own, start } from "./scenarios.js"

// What each harness does with a tool call, one call a model turn, for what comes of it: a
// read, a search, a command that passes and one that fails, an edit, a new file, a tool
// error, an edit that fails to match, a command that outlives its call. outcomes.e2e.ts holds
// each harness to what its `expected` steps say, in every run; the probe of the same name
// records all of them for the fixtures. The other steps' commands are Unix's alone.

type ToolCall = NonNullable<Reply["calls"]>[number]

/** What a call must come to: its outcome's parts, and its change's counts. */
export type Expected = Partial<Omit<ToolOutcome, "change">> & {
  readonly added?: number
  readonly removed?: number
}

export type Step = {
  readonly name: string
  readonly call: (call: Call, last: string) => ToolCall
  readonly expected?: Expected
  /** What the calls inside a script must come to, in order. */
  readonly scripted?: readonly Expected[]
}

/** One harness set up one way, with the steps it takes. */
export type Variant = {
  readonly agent: AgentSetup["agent"]
  readonly name: string
  readonly prepare: (run: E2E) => void
  readonly steps: (path: (name: string) => string) => readonly Step[]
}

const sample = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n"
const long = Array.from({ length: 400 }, (_, line) => `line ${line} ${"x".repeat(60)}`).join("\n")
const longer = long.replace("line 100 ", "line 100 changed ").replace("line 300 ", "")

const bash = (command: string, extra: Record<string, unknown> = {}): ToolCall => ({
  name: "Bash",
  input: { command, description: "probe", ...extra },
})

const claudeSteps: Variant["steps"] = (path) => [
  {
    name: "read",
    call: () => ({ name: "Read", input: { file_path: path("sample.txt") } }),
    expected: { failed: false, size: { count: 6, unit: "line" } },
  },
  {
    name: "read-part",
    call: () => ({ name: "Read", input: { file_path: path("sample.txt"), offset: 2, limit: 2 } }),
    expected: { failed: false, size: { count: 2, unit: "line" } },
  },
  {
    name: "tool-error",
    call: () => ({ name: "Read", input: { file_path: path("missing.txt") } }),
    expected: { failed: true },
  },
  { name: "command-passes", call: () => bash("echo hello"), expected: { failed: false } },
  {
    name: "command-fails",
    call: () => bash("echo boom >&2; exit 3"),
    expected: { failed: true, exit: 3 },
  },
  { name: "no-match", call: () => bash("grep -n zzz sample.txt") },
  { name: "timeout", call: () => bash("sleep 5; echo late", { timeout: 1000 }) },
  {
    name: "background",
    call: () => bash("echo done", { run_in_background: true }),
    expected: { failed: null, running: true },
  },
  {
    // A search tool is offered only on Windows, whose records no fixture holds yet.
    name: "search",
    call: (call) =>
      call.tools.includes("Grep")
        ? { name: "Grep", input: { pattern: "beta", path: path(".") } }
        : bash("grep -rn beta ."),
  },
  {
    name: "read-before-edit",
    call: () => ({ name: "Read", input: { file_path: path("src/auth.ts") } }),
    expected: { failed: false },
  },
  {
    name: "edit",
    call: () => ({
      name: "Edit",
      input: {
        file_path: path("src/auth.ts"),
        old_string: "const b = 2\n",
        new_string: "const b = 20\nconst bb = 21\n",
      },
    }),
    expected: { failed: false, added: 2, removed: 1 },
  },
  {
    name: "edit-no-match",
    call: () => ({
      name: "Edit",
      input: { file_path: path("src/auth.ts"), old_string: "no such text", new_string: "x" },
    }),
    expected: { failed: true },
  },
  {
    name: "new-file",
    call: () => ({ name: "Write", input: { file_path: path("new.txt"), content: "one\ntwo\n" } }),
    expected: { failed: false, added: 2, removed: 0 },
  },
  {
    name: "read-before-overwrite",
    call: () => ({ name: "Read", input: { file_path: path("sample.txt") } }),
  },
  {
    name: "overwrite",
    call: () => ({
      name: "Write",
      input: { file_path: path("sample.txt"), content: "alpha\nomega\n" },
    }),
  },
  {
    name: "read-before-long-edit",
    call: () => ({ name: "Read", input: { file_path: path("long.txt") } }),
  },
  {
    name: "long-edit",
    call: () => ({
      name: "Edit",
      input: { file_path: path("long.txt"), old_string: long, new_string: longer },
    }),
  },
  {
    name: "long-write",
    call: () => ({ name: "Write", input: { file_path: path("huge.txt"), content: long } }),
  },
]

const exec = (cmd: string, extra: Record<string, unknown> = {}): ToolCall => ({
  name: "exec_command",
  input: { cmd, yield_time_ms: 5000, ...extra },
})

const patch = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`
const addPatch = patch(`*** Add File: new.txt\n+one\n+two`)
const updatePatch = patch(
  `*** Update File: src/auth.ts\n@@\n const a = 1\n-const b = 2\n+const b = 20\n+const bb = 21\n const c = 3`,
)
const stalePatch = patch(`*** Update File: src/auth.ts\n@@\n-no such text\n+x`)
const movePatch = patch(`*** Update File: new.txt\n*** Move to: moved.txt\n@@\n-one\n+uno`)
const deletePatch = patch(`*** Delete File: moved.txt`)

const shellPatch = (text: string): ToolCall => exec(`apply_patch <<'EOF'\n${text}\nEOF`)

const codexShellSteps: Variant["steps"] = () => [
  { name: "command-passes", call: () => exec("echo hello") },
  { name: "command-fails", call: () => exec("sh -c 'echo boom >&2; exit 3'") },
  { name: "read", call: () => exec("cat sample.txt") },
  { name: "tool-error", call: () => exec("cat missing.txt") },
  { name: "search", call: () => exec("grep -n beta sample.txt") },
  { name: "no-match", call: () => exec("grep -n zzz sample.txt") },
  { name: "runs-on", call: () => exec("sleep 3; echo done", { yield_time_ms: 300 }) },
  {
    name: "poll-ends",
    call: (_call, last) => ({
      name: "write_stdin",
      input: {
        session_id: Number(/session ID (\d+)/.exec(last)?.[1]),
        chars: "",
        yield_time_ms: 6000,
      },
    }),
  },
  { name: "not-found", call: () => exec("no-such-program-here") },
  { name: "patch-add", call: () => shellPatch(addPatch) },
  { name: "patch-update", call: () => shellPatch(updatePatch) },
  { name: "patch-no-match", call: () => shellPatch(stalePatch) },
]

const freeform = (input: string): ToolCall => ({ name: "apply_patch", input: { input } })

const codexPatchSteps: Variant["steps"] = () => [
  { name: "command-passes", call: () => exec("echo hello"), expected: { failed: false, exit: 0 } },
  { name: "command-fails", call: () => exec("exit 3"), expected: { failed: true, exit: 3 } },
  {
    name: "add",
    call: () => freeform(addPatch),
    expected: { failed: false, exit: 0, added: 2, removed: 0 },
  },
  {
    name: "update",
    call: () => freeform(updatePatch),
    expected: { failed: false, exit: 0, added: 2, removed: 1 },
  },
  { name: "no-match", call: () => freeform(stalePatch), expected: { failed: true } },
  { name: "move", call: () => freeform(movePatch) },
  { name: "delete", call: () => freeform(deletePatch) },
]

const script = (input: string): ToolCall => ({ name: "exec", input: { input } })
const shown = (text: string) => JSON.stringify(text)

const codexScriptSteps: Variant["steps"] = () => [
  {
    name: "command-passes",
    call: () => script(`text(await tools.exec_command({cmd:"echo hello"}));`),
    expected: { failed: null },
    scripted: [{ failed: false, exit: 0 }],
  },
  {
    name: "command-fails",
    call: () => script(`text(await tools.exec_command({cmd:"exit 3"}));`),
    expected: { failed: null },
    scripted: [{ failed: true, exit: 3 }],
  },
  {
    name: "script-fails",
    call: () => script(`throw new Error("boom in the script");`),
    expected: { failed: true },
    scripted: [],
  },
  {
    name: "two-commands",
    call: () =>
      script(
        `const r = await Promise.allSettled([tools.exec_command({cmd:"echo one"}), tools.exec_command({cmd:"cat missing.txt"})]);\nfor (const each of r) text(each);`,
      ),
  },
  { name: "read", call: () => script(`text(await tools.exec_command({cmd:"cat sample.txt"}));`) },
  {
    name: "search",
    call: () => script(`text(await tools.exec_command({cmd:"grep -n beta sample.txt"}));`),
  },
  {
    name: "add",
    call: () => script(`text(await tools.apply_patch(${shown(addPatch)}));`),
    expected: { failed: null },
    scripted: [{ failed: false, added: 2, removed: 0 }],
  },
  {
    name: "update",
    call: () => script(`text(await tools.apply_patch(${shown(updatePatch)}));`),
    expected: { failed: null },
    scripted: [{ failed: false, added: 2, removed: 1 }],
  },
  {
    name: "no-match",
    call: () => script(`text(await tools.apply_patch(${shown(stalePatch)}));`),
    expected: { failed: true },
    scripted: [],
  },
  {
    name: "runs-on",
    call: () =>
      script(`text(await tools.exec_command({cmd:"sleep 3; echo done", yield_time_ms: 300}));`),
  },
]

const run = (CommandLine: string, WaitMsBeforeAsync = 5000): ToolCall => ({
  name: "run_command",
  input: { CommandLine, WaitMsBeforeAsync, toolSummary: "Run a command" },
})

const agySteps: Variant["steps"] = (path) => [
  {
    name: "read",
    call: () => ({ name: "read_file", input: { Path: path("sample.txt") } }),
    expected: { failed: false, size: { count: 6, unit: "line" } },
  },
  {
    name: "read-part",
    call: () => ({
      name: "read_file",
      input: { Path: path("sample.txt"), StartLine: 2, EndLine: 3 },
    }),
    expected: { failed: false, size: { count: 2, unit: "line" } },
  },
  {
    name: "tool-error",
    call: () => ({ name: "read_file", input: { Path: path("missing.txt") } }),
    expected: { failed: true },
  },
  { name: "command-passes", call: () => run("echo hello"), expected: { failed: false, exit: 0 } },
  { name: "command-fails", call: () => run("exit 3"), expected: { failed: true, exit: 3 } },
  { name: "no-match", call: () => run("grep -n zzz sample.txt") },
  { name: "not-found", call: () => run("no-such-program-here") },
  { name: "search", call: () => run("grep -rn beta .") },
  {
    name: "edit",
    call: () => ({
      name: "edit_file",
      input: {
        Path: path("src/auth.ts"),
        Target: "const b = 2\n",
        Replacement: "const b = 20\nconst bb = 21\n",
      },
    }),
    expected: { failed: false, added: 2, removed: 1 },
  },
  {
    name: "edit-no-match",
    call: () => ({
      name: "edit_file",
      input: { Path: path("src/auth.ts"), Target: "no such text", Replacement: "x" },
    }),
    expected: { failed: true },
  },
  {
    name: "new-file",
    call: () => ({ name: "write_file", input: { Path: path("new.txt"), Content: "one\ntwo\n" } }),
    expected: { failed: false, added: 2, removed: 0 },
  },
  {
    name: "file-exists",
    call: () => ({ name: "write_file", input: { Path: path("new.txt"), Content: "uno\n" } }),
    expected: { failed: true },
  },
  {
    name: "long-edit",
    call: () => ({
      name: "edit_file",
      input: { Path: path("long.txt"), Target: long, Replacement: longer },
    }),
  },
  {
    name: "long-write",
    call: () => ({ name: "write_file", input: { Path: path("huge.txt"), Content: long } }),
  },
  {
    name: "overwrite",
    call: () => ({
      name: "write_file",
      input: { Path: path("new.txt"), Content: "uno\n", Overwrite: true },
    }),
  },
  {
    name: "background",
    call: () => run("sleep 3; echo done", 500),
    expected: { failed: null, running: true },
  },
  { name: "wait", call: () => run("sleep 4; echo waited") },
  { name: "background-fails", call: () => run("sh -c 'sleep 2; exit 4'", 500) },
  { name: "wait-again", call: () => run("sleep 4; echo waited") },
]

export const allowClaude = ({ sandbox }: E2E): void => {
  const file = join(sandbox.home, ".claude", "settings.json")
  const settings = JSON.parse(readFileSync(file, "utf8")) as {
    permissions?: { allow?: string[] }
  }
  settings.permissions = {
    ...settings.permissions,
    allow: [
      ...(settings.permissions?.allow ?? []),
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
    ],
  }
  writeFileSync(file, JSON.stringify(settings))
}

// Everything runs unasked, in the sandbox the suite gives it, on a fake model whose catalog
// entry takes `entry` too, as `tool_mode` makes every real model's tools a script's.
export const openCodex = (
  { sandbox }: E2E,
  entry: Readonly<Record<string, unknown>> = {},
): void => {
  const home = join(sandbox.home, ".codex")
  const config = join(home, "config.toml")
  writeFileSync(
    config,
    `approval_policy = "never"\nsandbox_mode = "danger-full-access"\n${readFileSync(config, "utf8")}`,
  )
  const { models } = JSON.parse(catalog) as { models: Record<string, unknown>[] }
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({ models: models.map((model) => ({ ...model, ...entry })) }),
  )
}

export const variants: readonly Variant[] = [
  { agent: "claude", name: "claude", prepare: allowClaude, steps: claudeSteps },
  {
    agent: "codex",
    name: "codex-shell",
    prepare: (run_) => openCodex(run_),
    steps: codexShellSteps,
  },
  {
    agent: "codex",
    name: "codex-freeform",
    prepare: (run_) => openCodex(run_, { apply_patch_tool_type: "freeform" }),
    steps: codexPatchSteps,
  },
  {
    agent: "codex",
    name: "codex-code-mode",
    prepare: (run_) =>
      openCodex(run_, { tool_mode: "code_mode_only", apply_patch_tool_type: "freeform" }),
    steps: codexScriptSteps,
  },
  { agent: "agy", name: "agy", prepare: () => undefined, steps: agySteps },
]

export const setupOf = (variant: Variant): AgentSetup =>
  setups.find((one) => one.agent === variant.agent)!

/** The steps of a variant in a run, with paths into the run's project. */
export const stepsIn = (variant: Variant, { sandbox }: E2E): readonly Step[] =>
  variant.steps((name) => (name === "." ? sandbox.project : join(sandbox.project, name)))

const words = "Probed."

/**
 * Seeds the run's project and has the agent take `steps`, allowing whatever still asks, as
 * the person would, until the model says it is done. Gives the terminal; `onCall` sees each
 * call the model is answered, as the tools it was offered.
 */
export const takeSteps = async (
  run_: E2E,
  setup: AgentSetup,
  steps: readonly Step[],
  onCall?: (call: Call) => void,
): Promise<DeckTerminal> => {
  const at = (name: string) => join(run_.sandbox.project, name)
  mkdirSync(at("src"), { recursive: true })
  writeFileSync(at("sample.txt"), sample)
  writeFileSync(at("long.txt"), long)
  writeFileSync(at("src/auth.ts"), "const a = 1\nconst b = 2\nconst c = 3\n")
  run_.model.use(
    own((call) => {
      onCall?.(call)
      const done = call.turns.filter((turn) => turn.role === "tool")
      const step = steps[done.length]
      return step ? { calls: [step.call(call, done.at(-1)?.text ?? "")] } : { text: words }
    }),
  )
  const terminal = await start(run_, setup)
  await terminal.submit("Take the steps")
  await terminal.poll(
    async () => {
      const request = (await terminal.detail()).requests.find((each) => !each.answered)
      const { dialog } = request ?? {}
      const yes = dialog?.type === "choices" ? dialog.options[0] : undefined
      if (request && dialog?.type === "choices" && yes)
        await terminal
          .answer(request.ref, { dialog: dialog.id, type: "choice", option: yes.id })
          .catch(() => undefined)
      return (await terminal.screen()).includes(words) ? true : undefined
    },
    "the agent to take its steps",
    240_000,
  )
  return terminal
}
