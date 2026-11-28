import { join } from "node:path"

import { withLaunch } from "@novadeck/harness-core/decode"
import type { Harness, LaunchProfile } from "@novadeck/harness-core/harness"
import {
  chosenFlags,
  forgottenUnits,
  keptFlags,
  resumeFlags,
} from "@novadeck/harness-core/kept-flags"

import { box, slice } from "./box.js"
import { conversation, conversations } from "./conversation.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { dirs, home } from "./home.js"
import { fallbacks, installer } from "./install.js"
import { limited } from "./limited.js"
import { messaging } from "./messaging.js"
import { choose, readModels } from "./models.js"
import { connected, connectedFile, files, hook, hookDialect } from "./plugin.js"
import { conversational, shapes } from "./shapes.js"
import { commands, hooksTrusted, info, kept, makeCmdShim, posixShim, valued } from "./shim.js"
import { title } from "./startup.js"
import { followTranscript } from "./transcript-watch.js"
import { transcripts } from "./transcripts.js"

/**
 * How long a resume's prompt may show without its session bound before it counts as failed: long,
 * as the plugin binds only once opencode answered its version and that the session is there, which
 * took over 3 s on CI's Windows runners. A missing session never waits it out: opencode exits
 * ("Session not found"), and the shell's prompt coming back fails the resume at once.
 */
const resumeGraceMs = 15_000

const launch: LaunchProfile = {
  start: ["opencode"],
  // Its `--prompt` submits once its TUI is up, past no screen of its own (it has none), and
  // its MCP servers' tools reach every model call, a first one's too (`toolsAtTurnStart`).
  initialPrompt: (line) => Promise.resolve(["opencode", "--prompt", line]),
  // The plugin binds a `--session` as opencode starts, naming the claim; a missing one exits.
  resumed: (claim, { sessionId, ready, readyMs }) =>
    sessionId === claim
      ? "worked"
      : sessionId !== null || (ready && readyMs >= resumeGraceMs)
        ? "failed"
        : "waiting",
  resume: (session, choice = {}, carried = []) => [
    "opencode",
    ...choose(choice),
    ...resumeFlags(carried, choice, kept),
    "--session",
    session,
  ],
  kept: (argv) => keptFlags(argv, kept),
  forgets: (words) => forgottenUnits(words, kept),
  chosen: (words) => chosenFlags(words, kept),
  models: readModels,
  choose,
}

export const opencode = {
  id: "opencode",
  plugin: "opencode",
  installer,
  fallbacks,
  conversation,
  conversations,
  home,
  // The plans its plan agent writes with its experimental plan mode, outside a project.
  planFolders: (install) => [join(dirs(install).data, "plans")],
  // What it keeps for itself: its sessions, logs, snapshots and plans, and its caches.
  bookkeeping: (install) => {
    const { data, state, cache } = dirs(install)
    return [data, state, cache]
  },
  connected,
  // Nothing of opencode's own installs it: the shim loads the plugin per launch.
  marker: (install) => join(install.plugin, connectedFile),
  connect: () => [],
  disconnect: [],
  hookDialect,
  hook,
  files,
  // A shim that loads Novadeck's plugin for the launch (see shim.ts); on Windows a batch file.
  shims: (platform, machine = {}) =>
    platform !== "win32"
      ? [{ path: "opencode", content: posixShim(machine.worktreesRoot), mode: 0o700 }]
      : [
          {
            path: "opencode.cmd",
            content: makeCmdShim({ cmdShimDir: machine.cmdShimDir, root: machine.worktreesRoot }),
          },
        ],
  limited,
  nonSession: {
    commands,
    flags: info,
    takesValue: valued,
    takesMany: ["--cors"],
    print: [],
  },
  transcripts: { ...transcripts, shapes, conversational },
  // Nothing outlives a turn: a task's subagent runs within its call.
  wakes: false,
  hookGate: true,
  // Its Stop is the end: `session.idle` comes for every turn however it ended, its error
  // saying an Escape (`MessageAbortedError`), and nothing later says otherwise.
  records: false,
  coverage: {
    session: "complete",
    activity: "complete",
    attention: "complete",
    actors: "complete",
    transcripts: "partial",
    planning: "partial",
    usage: "partial",
    limits: "unsupported",
    context: "complete",
  },
  decode: (report) => withLaunch(decode(report), report, launch.kept),
  watch: followTranscript,
  dialogs,
  commandFields: ["command"],
  // No screen of its own holds it before its prompt, signed in or not (probed 2026-11-22,
  // 1.19.6): a missing or refused key shows only as its first turn's error.
  title,
  hooksTrusted,
  launch,
  messaging,
  box,
  slice,
} satisfies Harness
