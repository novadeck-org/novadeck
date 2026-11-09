import { hookTranscript, withLaunch } from "@novadeck/harness-core/decode"
import type { Harness, LaunchProfile, MessagingProfile } from "@novadeck/harness-core/harness"
import {
  forgottenUnits,
  keptFlags,
  resumeFlags,
  type KeptFlags,
} from "@novadeck/harness-core/kept-flags"

import { bannerMarker, bannerVersion } from "./banner.js"
import { box, slice } from "./box.js"
import { conversation, conversations } from "./conversation.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { codexHome } from "./home.js"
import { readModels } from "./models.js"
import { connect, connected, disconnect, files, hook, hookDialect } from "./plugin.js"
import { followRollout, followSubagent, rolloutPlans } from "./rollout.js"
import { conversational, shapes } from "./shapes.js"
import { cmdShim, posixShim } from "./shim.js"
import { startedSession, title, titleWorking } from "./title.js"
import { transcripts } from "./transcripts.js"
import { hooksTrusted } from "./trust.js"

// What a hook prints to hand the model `delivery` as context.
const context = (event: string, delivery: string): string =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: delivery } })}\n`

// A Stop's reason continues the turn as a user-role hook prompt, which the delivery's
// wrapper still attributes to its sender; a prompt's context is a developer message, and
// so is a PostToolUse's, which the model reads on its next request.
const messaging: MessagingProfile = {
  exitCommands: ["/exit", "/quit"],
  asks: { Stop: "stop", UserPromptSubmit: "prompt", PostToolUse: "tool" },
  silent: { "*": "" },
  stop: (delivery) => `${JSON.stringify({ decision: "block", reason: delivery })}\n`,
  prompt: (delivery) => context("UserPromptSubmit", delivery),
  call: (delivery, event) => context(event, delivery),
  reinjectPerCall: false,
  // A Stop's reason and a hook's context are items of its rollout, which it sends again on
  // every later call, and a resumed session's too; its `SessionStart` says `compact` once
  // it compacted them away.
  lasting: ["stop", "prompt", "tool"],
  root: "binding",
  queueKey: "\t",
  silentOnFailure: true,
  // Escape denies an approval or abandons request_user_input, and aborts the turn
  // (`turn_aborted`, probed 2026-11-09, 0.167.0, e2e/probes/question-dismiss.e2e.ts).
  dialogEscape: "interrupts",
  // A spawned agent running, the root idle, it took a typed prompt (fixture
  // `background-prompt.probe.json`, probed 2026-10-19, 0.163.0).
  promptsInBackground: true,
  // A turn started before Novadeck's server listed its tools gets them at its next
  // request once it has (probed 2026-11-05, 0.166.0, with that server 3 s slow to start).
  toolsAtTurnStart: false,
}

const nonSession = {
  commands: [
    "agents",
    "login",
    "logout",
    "mcp",
    "plugin",
    "app-server",
    "remote-control",
    "completion",
    "update",
    "doctor",
    "sandbox",
    "debug",
    "apply",
    "a",
    "archive",
    "delete",
    "migrate-rollouts",
    "migrate-nfs-db",
    "unarchive",
    "exec-server",
    "features",
    "help",
  ],
  flags: ["-h", "--help", "-V", "--version"],
  // Its `exec` runs it on a prompt, but that is a command; its `-p` is `--profile`.
  print: [],
  takesValue: [
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--remote",
    "--remote-auth-token-env",
    "-i",
    "--image",
    "-m",
    "--model",
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "--add-dir",
    "-a",
    "--ask-for-approval",
  ],
  takesMany: ["-i", "--image"],
}

// What a resume carries over: the approval policy and sandbox, however they were asked for
// (a flag, its bypass or a config override of the same key), the model and the effort, which
// `codex resume` doesn't bring back with the session (see `LaunchProfile.kept`).
const configKeys = ["model", "model_reasoning_effort", "approval_policy", "sandbox_mode"]
const kept: KeptFlags = {
  valued: {
    "-m": "--model",
    "--model": "--model",
    "-s": "--sandbox",
    "--sandbox": "--sandbox",
    "-a": "--ask-for-approval",
    "--ask-for-approval": "--ask-for-approval",
  },
  bare: {
    "--dangerously-bypass-approvals-and-sandbox": "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust": "--dangerously-bypass-hook-trust",
    "--approve-for-me": "--approve-for-me",
    "--full-auto": "--full-auto",
  },
  config: { options: ["-c", "--config"], keys: configKeys },
  // Probed 2026-11-07 (0.167.0, launch-flags.e2e.ts): a bare `codex resume` brings back the
  // model, the effort, the sandbox, the approval policy and the full bypass (`/status` matched
  // the launch's), so none of those is given back; all are still read and saved with the
  // session. Hook trust is not the session's: launched with `--dangerously-bypass-hook-trust`
  // and untrusted hooks, its hooks ran, and a bare `codex resume` of that session showed
  // "Hooks need review" and ran none (same probe, `codex.hook-trust.probe.json`).
  forgets: ["--dangerously-bypass-hook-trust"],
  takesValue: nonSession.takesValue,
  takesMany: nonSession.takesMany,
  print: nonSession.print,
  sets: (flag, value) =>
    flag === "--model" || value?.startsWith("model=")
      ? "model"
      : value?.startsWith("model_reasoning_effort=")
        ? "effort"
        : undefined,
}

const launch: LaunchProfile = {
  start: ["codex"],
  // It holds a command-line prompt behind its trust and startup screens.
  initialPrompt: (line) => Promise.resolve(["codex", line]),
  // It has no id before its first prompt: reaching ready with the resume running is its
  // sign (an id it never had exits with the shell prompt back instead), and binding clears
  // ready, so an id that is the claim counts as well.
  resumed: (claim, { sessionId, ready }) => (sessionId === claim || ready ? "worked" : "waiting"),
  // `tui.resume_cwd=session` keeps the working-directory question from blocking the resume
  // when the shell's folder is not the session's, as after a `cd` (probed 2026-11-07, 0.167.0,
  // on Linux, macOS and Windows; `-C <dir>` does the same). It is one plain word, as `choose`'s
  // `-c` values are, so every shell and the shims' `%*` and `"$@"` pass it whole. The session's
  // folder, if deleted, still blocks: its availability check says so first.
  resume: (session, choice = {}, carried = []) => [
    "codex",
    "resume",
    ...launch.choose(choice),
    ...resumeFlags(carried, choice, kept),
    "-c",
    "tui.resume_cwd=session",
    session,
  ],
  kept: (argv) => keptFlags(argv, kept),
  forgets: (words) => forgottenUnits(words, kept),
  // Its cache of the models it lists, in its home; the effort is a config override, left
  // bare (codex reads a value that isn't TOML as a string), so it has no quotes of its own.
  models: (install) => readModels(codexHome(install)),
  choose: ({ model, effort }) => [
    ...(model !== undefined ? ["--model", model] : []),
    ...(effort !== undefined ? ["-c", `model_reasoning_effort=${effort}`] : []),
  ],
}

export const codex = {
  id: "codex",
  plugin: "codex",
  conversation,
  conversations,
  home: codexHome,
  connected,
  connect,
  disconnect,
  hookDialect,
  hook,
  files,
  // Interactive Codex runs its sessions, and their hooks, in a shared background server
  // that knows nothing of the terminal it was started from; see `./shim.ts`.
  shims: (platform) =>
    platform === "win32"
      ? [{ path: "codex.cmd", content: cmdShim }]
      : [{ path: "codex", content: posixShim, mode: 0o700 }],
  // Its subcommands other than a session (`codex --help`, 0.164.0), with help and version.
  // Its `exec` and `review` run it on the caller's text, as `queue` (a message into a
  // session) and `cloud` (`cloud exec` submits a task) do, so they are a session's use.
  nonSession,
  transcripts: { ...transcripts, shapes, conversational },
  plans: rolloutPlans,
  // Its hooks and rollout; see docs/harness-coverage.md.
  // Nothing it starts wakes it once its turn has ended (probed 2026-10-02, 0.159.3): a
  // subagent or a command left running finishes with the root idle.
  wakes: false,
  records: true,
  coverage: {
    session: "partial",
    activity: "partial",
    attention: "partial",
    actors: "partial",
    transcripts: "partial",
    planning: "partial",
    usage: "unsupported",
    limits: "complete",
    context: "partial",
  },
  decode: (report) => withLaunch(decode(report), report, launch.kept),
  transcriptOf: hookTranscript,
  dialogs,
  commandFields: ["command"],
  title,
  titleWorking,
  screenVersion: bannerVersion,
  screenMarker: bannerMarker,
  startedSession,
  hooksTrusted,
  // Where it keeps its threads' locks and its configuration, and how it is found.
  environment: ["PATH", "HOME", "CODEX_HOME"],
  launch,
  messaging,
  box,
  slice,
  // The rollout records the session's tokens and the account's rate-limit windows, each
  // turn's mode and the plans it proposes.
  watch: followRollout,
  // A subagent's rollout records Esc on its request, which no hook reports.
  watchActor: followSubagent,
} satisfies Harness
