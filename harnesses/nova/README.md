# @novadeck/harness-nova

Nova, Novadeck's own agent: a pinned build of pi that Novadeck downloads itself and runs on an
agent folder of its own and on the model Novadeck pays for. It is
agent `pi` on pi's adapter (`harnesses/pi`), which this package builds on and which never
reaches back.

## What's here

- **`pin.ts`**: the pinned pi (version, builds and checksums by system, licence) and where it
  lives under Novadeck's data folder: `bundled/pi/<version>-<sha>` for a build, `bundled/pi/agent`
  for its settings, sign-ins and sessions, and whether a session is Nova's, by its transcript's
  folder. The runner's `harnesses/bundled-pi.ts` downloads it behind its Experimental switch.
- **`launcher.ts`**: the launchers (POSIX and cmd) the runner writes to `shell/bundled/pi[.cmd]`,
  which ask the runner for the program (`novadeck-relay fetch pi`) and start it with Novadeck's
  extension; the word `novadeck-pi` commands start it by, which is on no PATH, so no program of
  the person's (another `nova`, say) is taken for it; and the marks that tell Nova apart from the
  person's pi.
- **`startup.ts`**: a startup command's word turned into the launcher's path, as the terminal's
  shell runs it.
- **`model.ts`**: the model Nova runs on, through Novadeck's model service, and the variables its
  terminal gets it in.
- **`extension.ts`**: `withNova`, pi's adapter with that model in its extension, which the
  runner's registry uses for agent `pi`.

## Contract

- **Nova is agent `pi`**: on the wire and in storage, Nova's sessions are pi's, told apart by
  their transcripts' folder (`ownPiSession`) and the extension's mark (`fromOwnPi`). Nothing on a
  person's computer is renamed: folders, files and variables keep their names.
