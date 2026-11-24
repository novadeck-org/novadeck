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
 * What a resume names for `--session`: the session's file where its hooks named one, as pi opens a
 * file in its own folder from any other, where an id from another folder than the session's asks
 * to fork it first ("Session found in different project … Fork this session into current
 * directory? [y/N]", probed 2026-11-24, 1.6.0); else its id. Only a file whose path every shell
 * reads as one plain word, as the resume's words are joined into the command the person's shell
 * runs: an absolute path to a `.jsonl` file, of letters, digits and `_ . / : @ + = -` (and `\`
 * as a Windows path's separator).
 */
export const resumedBy = (session: string, transcript: string | undefined): string =>
  transcript !== undefined &&
  (/^\/[A-Za-z0-9_./:@+=-]+\.jsonl$/.test(transcript) ||
    /^[A-Za-z]:\\[A-Za-z0-9_.\\:@+=-]+\.jsonl$/.test(transcript))
    ? transcript
    : session

/**
 * How pi starts in a terminal. A new session's id is pi's own, which the extension reports as
 * the session starts; a resume names one with `--session`, which opens it in its own folder (pi's
 * `--session-id` would make a new, empty session of that id in another folder: docs/cli.md, 1.6.0),
 * by its file where it can (`resumedBy`).
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
  resume: (session, choice = {}, carried = [], transcript) => [
    "pi",
    ...choose(choice),
    ...resumeFlags(carried, choice, kept),
    "--session",
    resumedBy(session, transcript),
  ],
  kept: (argv) => keptFlags(argv, kept),
  forgets: (words) => forgottenUnits(words, kept),
  models: readModels,
  choose,
}
