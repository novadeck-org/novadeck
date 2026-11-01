import { join } from "node:path"

import type { Harness, LaunchProfile, MessagingProfile } from "@novadeck/harness-core/harness"

import { box } from "./box.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { antigravityHome } from "./home.js"
import { models } from "./models.js"
import { closedAnswer, notCommandAnswer, runAnswer, takesSettings } from "./narrow.js"
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
import { statusLineLimit, statusLineSettings, trustsFolder } from "./settings.js"
import { commands, makeCmdShim, posixShim } from "./shim.js"
import { shown } from "./status-line.js"
import { transcripts, typedEntry } from "./transcripts.js"

// A Stop continued with a reason gets it as a lasting system step. A message injected at
// a model call lasts only for that call, so a turn's delivery is injected again on each
// of its later calls. Every other answer is an empty object.
const messaging: MessagingProfile = {
  asks: { Stop: "stop", PreInvocation: "prompt" },
  // Its PreToolUse is answered at once from the person's grants, in a narrowed terminal only
  // (see narrow.ts): without NOVADECK_NARROW it answers as it always did, "ask".
  permission: {
    event: "PreToolUse",
    reported: true,
    narrowed: {
      run: `${runAnswer}\n`,
      notCommand: `${notCommandAnswer}\n`,
      closed: `${closedAnswer}\n`,
    },
  },
  silent: { PreToolUse: `${preToolUseAnswer}\n`, "*": "{}\n" },
  // In a narrowed terminal the answer nothing gave is the closed one.
  narrowed: { PreToolUse: `${closedAnswer}\n` },
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
  // Its hooks name no prompt, but its transcript tells what was typed (a USER_EXPLICIT
  // USER_INPUT step) from what woke it: a subagent's message, a Stop hook's continuation
  // or a notice are SYSTEM_MESSAGE steps, and injected messages EPHEMERAL_MESSAGE ones.
  typedEntry,
}

const launch: LaunchProfile = {
  start: ["agy"],
  // `-i` submits its prompt about 0.9 s after it starts, even while its "Do you trust
  // this folder?" dialog is up, so only in a folder it already trusts.
  initialPrompt: async (line, { install, cwd }) =>
    install && (await trustsFolder(install, cwd)) ? ["agy", "-i", line] : undefined,
  resume: (session, choice = {}) => ["agy", ...launch.choose(choice), "--conversation", session],
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
  home: antigravityHome,
  connected,
  installed,
  connect,
  disconnect,
  hookDialect,
  hook,
  files,
  takesLaunchGrants: takesSettings,
  // Novadeck's shim, which starts it narrowed where a grant covers its terminal.
  shims: (platform, machine = {}) =>
    platform === "win32"
      ? [{ path: "agy.cmd", content: makeCmdShim(machine.cmdShimDir) }]
      : [{ path: "agy", content: posixShim, mode: 0o700 }],
  // Its status line tells what no hook does: working or idle, a confirmation waiting on
  // the person, and its context and quotas.
  settings: statusLineSettings,
  limited: statusLineLimit,
  // Its subcommands (`agy --help`, 1.4.8), with help and version (`-v` is no version flag
  // there: it takes an argument, as `agy -v` says). Its print mode, `--print`, `-p` and
  // `--prompt`, runs it on the caller's text, so it is a session's use.
  nonSession: {
    commands,
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
      "-v",
    ],
  },
  transcripts,
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
  decode,
  dialogs,
  shown,
  launch,
  messaging,
  box,
} satisfies Harness
