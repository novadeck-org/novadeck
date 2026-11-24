import { join } from "node:path"

import { withLaunch } from "@novadeck/harness-core/decode"
import type { Harness, LaunchProfile } from "@novadeck/harness-core/harness"
import { forgottenUnits, keptFlags, resumeFlags } from "@novadeck/harness-core/kept-flags"

import { box, slice } from "./box.js"
import { conversation, conversations } from "./conversation.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { agentDir, home } from "./home.js"
import { fallbacks, installer } from "./install.js"
import { limited } from "./limited.js"
import { messaging } from "./messaging.js"
import { choose, readModels } from "./models.js"
import { connected, connectedFile, files, hook, hookDialect } from "./plugin.js"
import { conversational, shapes } from "./shapes.js"
import { commands, info, kept, shims, valued } from "./shim.js"
import { title } from "./startup.js"
import { transcripts } from "./transcripts.js"

const launch: LaunchProfile = {
  start: ["pi"],
  // A message argument is its first prompt, and it stays interactive.
  initialPrompt: (line) => Promise.resolve(["pi", line]),
  // A skeleton: the session is bound once the extension reports it.
  resumed: (claim, { sessionId }) => (sessionId === claim ? "worked" : "waiting"),
  resume: (session, choice = {}, carried = []) => [
    "pi",
    ...choose(choice),
    ...resumeFlags(carried, choice, kept),
    "--session-id",
    session,
  ],
  kept: (argv) => keptFlags(argv, kept),
  forgets: (words) => forgottenUnits(words, kept),
  models: readModels,
  choose,
}

/**
 * pi, as Novadeck's fifth harness. A skeleton: the pieces that need pi's own signals and screens
 * (decode, transcripts, the box, the extension, the shim) are stubs their owners fill in.
 */
export const pi = {
  id: "pi",
  plugin: "pi",
  installer,
  fallbacks,
  conversation,
  conversations,
  home,
  // What it keeps for itself: its agent folder (sessions, logins, settings).
  bookkeeping: (install) => [agentDir(install)],
  connected,
  // Nothing of pi's own installs it: the shim loads the extension per launch.
  marker: (install) => join(install.plugin, connectedFile),
  connect: () => [],
  disconnect: [],
  hookDialect,
  hook,
  files,
  shims,
  limited,
  nonSession: { commands, flags: info, takesValue: valued, takesMany: [], print: kept.print },
  transcripts: { ...transcripts, shapes, conversational },
  wakes: false,
  // It never asks: its extension's refusal of a shell command is the whole gate.
  hookGate: true,
  records: false,
  coverage: {
    session: "complete",
    activity: "complete",
    attention: "partial",
    actors: "partial",
    transcripts: "partial",
    planning: "unsupported",
    usage: "partial",
    limits: "unsupported",
    context: "partial",
  },
  decode: (report) => withLaunch(decode(report), report, launch.kept),
  dialogs,
  commandFields: ["command"],
  title,
  launch,
  messaging,
  box,
  slice,
} satisfies Harness
