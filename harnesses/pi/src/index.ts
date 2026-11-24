import { join } from "node:path"

import { withLaunch } from "@novadeck/harness-core/decode"
import type { Harness } from "@novadeck/harness-core/harness"

import { box, slice } from "./box.js"
import { conversation, conversations } from "./conversation.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { agentDir, home } from "./home.js"
import { fallbacks, installer } from "./install.js"
import { launch } from "./launch.js"
import { limited } from "./limited.js"
import { messaging } from "./messaging.js"
import { connected, connectedFile, files, hook, hookDialect, pidVariable } from "./plugin.js"
import { conversational, shapes } from "./shapes.js"
import { commands, info, kept, shims, valued } from "./shim.js"
import { heldScreen, screenMarker, screenVersion, signedOut, title } from "./startup.js"
import { followTranscript } from "./transcript-watch.js"
import { transcripts } from "./transcripts.js"
import { hooksTrusted } from "./trust.js"
import { versionOf } from "./version.js"

/** pi, as Novadeck's fifth harness: its extension, shim, transcripts, screens and input box. */
export const pi = {
  id: "pi",
  plugin: "pi",
  installer,
  fallbacks,
  // Another program is called `pi` (Ubuntu's apt package): only one that says a version is pi.
  identifies: (program, install) => versionOf(program, install.env).then((v) => v !== undefined),
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
  // Its own process, as the extension names it to its hooks: on Windows pi runs as `node.exe`.
  pidVariable,
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
  // A run's end the extension marks in the session's file, for a Stop whose report never came.
  watch: followTranscript,
  dialogs,
  commandFields: ["command"],
  heldScreen,
  signedOut,
  screenVersion,
  screenMarker,
  title,
  hooksTrusted,
  launch,
  messaging,
  box,
  slice,
} satisfies Harness
