import { join } from "node:path"

import { withLaunch } from "@novadeck/harness-core/decode"
import type { Harness, LaunchProfile, MessagingProfile } from "@novadeck/harness-core/harness"
import { keptFlags, resumeFlags, type KeptFlags } from "@novadeck/harness-core/kept-flags"
import { beside } from "@novadeck/harness-core/paths"

import { box, slice } from "./box.js"
import { conversation, conversations } from "./conversation.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { antigravityHome } from "./home.js"
import { followHolds } from "./listing.js"
import { models } from "./models.js"
import {
  connect,
  connected,
  disconnect,
  files,
  hook,
  hookDialect,
  installed,
  pluginId,
  preToolUseAnswer,
} from "./plugin.js"
import { statusLineLimit, statusLineSettings } from "./settings.js"
import { conversational, shapes } from "./shapes.js"
import { makeCmdShim } from "./shim.js"
import { shown, startupScreen } from "./status-line.js"
import { transcripts, typedEntry } from "./transcripts.js"

// A Stop continued with a reason gets it as a lasting system step. A message injected at
// a model call lasts only for that call, so a turn's delivery is injected again on each
// of its later calls. Every other answer is an empty object.
const messaging: MessagingProfile = {
  // `/exit` as docs/harness-coverage.md has it leave, and `/quit`, the alias its binary
  // names; a wrong one costs only the grace.
  exitCommands: ["/exit", "/quit"],
  asks: { Stop: "stop", PreInvocation: "prompt" },
  silent: { PreToolUse: `${preToolUseAnswer}\n`, "*": "{}\n" },
  stop: (delivery) => `${JSON.stringify({ decision: "continue", reason: delivery })}\n`,
  prompt: (delivery) => `${JSON.stringify({ injectSteps: [{ ephemeralMessage: delivery }] })}\n`,
  reinjectPerCall: true,
  // Its injected messages last one model call, and no hook tells of a compaction, so
  // every delivery carries its note in full.
  lasting: [],
  root: "status-line",
  silentOnFailure: false,
  // A subagent running, it took a typed prompt (fixture
  // `background-prompt.probe.json`, probed 2026-10-19, 1.2.14).
  promptsInBackground: true,
  // A turn's tools are those its MCP servers had listed as it started: with Novadeck's
  // server 3 s slow to start, `agy -i`'s first request went 0.3 s in, and none of that
  // turn's five over 6 s offered Novadeck's tools; its next turn's did, and holding the
  // turn's first PreInvocation 4 s changed nothing (probed 2026-11-05, 1.4.12 and 1.5.1).
  toolsAtTurnStart: true,
  // Its hooks name no prompt, but its transcript tells what was typed (a USER_EXPLICIT
  // USER_INPUT step) from what woke it: a subagent's message, a Stop hook's continuation
  // or a notice are SYSTEM_MESSAGE steps, and injected messages EPHEMERAL_MESSAGE ones.
  typedEntry,
}

/** How long a prompt with no id yet may wait for one before the resume counts as failed. */
const resumeGraceMs = 3_000
const nonSession = {
  commands: [
    "agent",
    "agents",
    "changelog",
    "help",
    "install",
    "mcp",
    "mic-serve",
    "models",
    "plugin",
    "plugins",
    "remote-control",
    "update",
  ],
  flags: ["-h", "--help", "--version"],
  print: ["-p", "--print", "--prompt"],
  takesValue: [
    "--add-dir",
    "--agent",
    "--conversation",
    "--effort",
    "-i",
    "--input-format",
    "--json-schema",
    "--log-file",
    "--mode",
    "--model",
    "--output-format",
    "--print-timeout",
    "--project",
    "--prompt-interactive",
    "--settings",
    "-v",
  ],
  takesMany: [],
}

// What a resume carries over: the execution mode, the permission bypass, the sandbox, the
// model and the effort, which `--conversation` doesn't bring back with the conversation (see
// `LaunchProfile.kept`). Go's `flag` reads `-mode x` as `--mode x`.
const kept: KeptFlags = {
  oneDash: true,
  valued: { "--model": "--model", "--effort": "--effort", "--mode": "--mode" },
  bare: {
    "--dangerously-skip-permissions": "--dangerously-skip-permissions",
    "--sandbox": "--sandbox",
  },
  // Probed 2026-11-07 (1.5.2, launch-flags.e2e.ts): a bare `--conversation` brings back none of
  // its mode, model or effort (the footer shows the defaults again), so all are given back,
  // though a `/model` changed since is undone by the launch's. `--sandbox` shows nowhere to probe.
  forgets: ["--mode", "--model", "--effort", "--dangerously-skip-permissions", "--sandbox"],
  takesValue: nonSession.takesValue,
  takesMany: nonSession.takesMany,
  print: nonSession.print,
  sets: (flag) => (flag === "--model" ? "model" : flag === "--effort" ? "effort" : undefined),
}

const launch: LaunchProfile = {
  start: ["agy"],
  // Never with its task: `-i` submits its prompt within a second of its start, before
  // Novadeck's MCP server may have listed its tools, which that turn then never has
  // (`toolsAtTurnStart`), and even while its "Do you trust this folder?" dialog is up. It
  // starts plain, and the doorbell rings its task once its prompt shows and that server
  // has listed its tools.
  initialPrompt: () => Promise.resolve(undefined),
  // Its status line gives the id, and an id it never had starts a new conversation
  // without a word: a different id is a failed resume at once, and none once its prompt has
  // shown for a grace is too (a good resume reports its id 0.5 to 0.8 s after its banner, a
  // missing conversation reaches its prompt in about the same time, so the order can race).
  resumed: (claim, { sessionId, ready, readyMs }) =>
    sessionId === claim
      ? "worked"
      : sessionId !== null || (ready && readyMs >= resumeGraceMs)
        ? "failed"
        : "waiting",
  resume: (session, choice = {}, carried = []) => [
    "agy",
    ...launch.choose(choice),
    ...resumeFlags(carried, choice, kept),
    "--conversation",
    session,
  ],
  kept: (argv) => keptFlags(argv, kept),
  models: () => Promise.resolve(models),
  choose: ({ model, effort }) => [
    ...(model !== undefined ? ["--model", model] : []),
    ...(effort !== undefined ? ["--effort", effort] : []),
  ],
}

export const agy = {
  id: "agy",
  // Antigravity installs a plugin folder, which its name must match.
  plugin: join("agy", pluginId),
  conversation,
  conversations,
  home: antigravityHome,
  // The folders of its conversations, where it writes the plans it asks to be reviewed.
  planFolders: (install) => [join(antigravityHome(install), "brain")],
  planFoldersOf: (transcript) => beside(transcript, "brain", "brain"),
  connected,
  installed,
  connect,
  disconnect,
  hookDialect,
  hook,
  files,
  // Windows only, and only where cmd's AutoRun prints and Novadeck's cmd.exe pass-through is
  // installed (`machine.cmdShimDir`): a shim that puts the pass-through first on PATH.
  shims: (platform, machine = {}) =>
    platform === "win32" && machine.cmdShimDir !== undefined
      ? [{ path: "agy.cmd", content: makeCmdShim(machine.cmdShimDir) }]
      : [],
  // Its status line tells what no hook does: working or idle, a confirmation waiting on
  // the person, and its context and quotas.
  settings: statusLineSettings,
  limited: statusLineLimit,
  // Its subcommands (`agy --help`, 1.4.8), with help and version (`-v` is no version flag
  // there: it takes an argument, as `agy -v` says). Its print mode, `--print`, `-p` and
  // `--prompt`, runs it on the caller's text, so it is a session's use.
  nonSession,
  transcripts: { ...transcripts, shapes, conversational },
  // Its hooks name no subagents; its status line counts them; see docs/harness-coverage.md.
  // A background subagent's end wakes it with a message saying it went idle.
  wakes: true,
  records: false,
  coverage: {
    session: "partial",
    activity: "partial",
    attention: "partial",
    actors: "unsupported",
    transcripts: "partial",
    planning: "partial",
    usage: "unsupported",
    limits: "partial",
    context: "partial",
  },
  decode: (report) => withLaunch(decode(report), report, launch.kept),
  watch: followHolds,
  dialogs,
  commandFields: ["CommandLine"],
  shown,
  startupScreen,
  launch,
  messaging,
  box,
  slice,
} satisfies Harness
