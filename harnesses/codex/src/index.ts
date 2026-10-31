import type { Harness, LaunchProfile, MessagingProfile } from "@novadeck/harness-core/harness"

import { box } from "./box.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { codexHome } from "./home.js"
import { readModels } from "./models.js"
import { connect, connected, disconnect, files, hook, hookDialect } from "./plugin.js"
import { followRollout, followSubagent, rolloutPlans } from "./rollout.js"
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
  asks: { Stop: "stop", UserPromptSubmit: "prompt", PostToolUse: "tool" },
  // Its permission request, answered at once from the person's grants.
  permission: {
    event: "PermissionRequest",
    reported: true,
    allow: `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    })}\n`,
  },
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
  // A spawned agent running, the root idle, it took a typed prompt (fixture
  // `background-prompt.probe.json`, probed 2026-10-19, 0.163.0).
  promptsInBackground: true,
}

const launch: LaunchProfile = {
  start: ["codex"],
  // It holds a command-line prompt behind its trust and startup screens.
  initialPrompt: (line) => Promise.resolve(["codex", line]),
  resume: (session, choice = {}) => ["codex", "resume", ...launch.choose(choice), session],
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
  nonSession: {
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
  },
  transcripts,
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
  decode,
  dialogs,
  title,
  titleWorking,
  startedSession,
  hooksTrusted,
  // Where it keeps its threads' locks and its configuration, and how it is found.
  environment: ["PATH", "HOME", "CODEX_HOME"],
  launch,
  messaging,
  box,
  // The rollout records the session's tokens and the account's rate-limit windows, each
  // turn's mode and the plans it proposes.
  watch: followRollout,
  // A subagent's rollout records Esc on its request, which no hook reports.
  watchActor: followSubagent,
} satisfies Harness
