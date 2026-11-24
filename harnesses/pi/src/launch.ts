import type { LaunchProfile } from "@novadeck/harness-core/harness"
import { forgottenUnits, keptFlags, resumeFlags } from "@novadeck/harness-core/kept-flags"

import { choose, readModels } from "./models.js"
import { kept } from "./shim.js"

/**
 * How long a resume's prompt may show without its session bound before it counts as failed. The
 * extension binds a resumed session as pi starts it, before its prompt draws, so this only
 * waits out a slow start; a session pi can't find never binds.
 */
const resumeGraceMs = 15_000

/**
 * How pi starts in a terminal. A new session's id is pi's own, which the extension reports as
 * the session starts; a resume names one with `--session`, which opens it in its own folder (pi's
 * `--session-id` would make a new, empty session of that id in another folder: docs/cli.md, 1.6.0).
 */
export const launch: LaunchProfile = {
  start: ["pi"],
  // A message argument is its first prompt, and pi stays interactive (docs/cli.md); the extension
  // gives pi Novadeck's tools as its session starts, before that prompt's model call.
  initialPrompt: (line) => Promise.resolve(["pi", line]),
  resumed: (claim, { sessionId, ready, readyMs }) =>
    sessionId === claim
      ? "worked"
      : sessionId !== null || (ready && readyMs >= resumeGraceMs)
        ? "failed"
        : "waiting",
  resume: (session, choice = {}, carried = []) => [
    "pi",
    ...choose(choice),
    ...resumeFlags(carried, choice, kept),
    "--session",
    session,
  ],
  kept: (argv) => keptFlags(argv, kept),
  forgets: (words) => forgottenUnits(words, kept),
  models: readModels,
  choose,
}
