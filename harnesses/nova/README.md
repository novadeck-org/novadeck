# @novadeck/harness-nova

Nova, Novadeck's own agent: a pinned build of pi that Novadeck downloads itself and runs on an
agent folder of its own and on the models Novadeck pays for (GPT-6 Luna, GPT-6.1 Terra and
GPT-6.2 Sol, every effort from low to max). It is
agent `pi` on pi's adapter (`harnesses/pi`), which this package builds on and which never
reaches back.

## What's here

- **`pin.ts`**: the pinned pi (version, builds and checksums by system, licence) and where it
  lives under Novadeck's data folder: `nova/<version>-<sha>` for a build, `nova/agent`
  for its settings, sign-ins and sessions, and whether a session is Nova's, by its transcript's
  folder. The runner's `harnesses/nova.ts` downloads it behind its Experimental switch.
- **`launcher.ts`**: the launchers (POSIX and cmd) the runner writes to `shell/nova/nova[.cmd]`,
  which ask the runner for the program (`novadeck-relay fetch nova`) and start it with Novadeck's
  extension; the word `novadeck-nova` commands start it by, which is on no PATH, so no program of
  the person's (another `nova`, say) is taken for it; and the marks that tell Nova apart from the
  person's pi.
- **`startup.ts`**: a startup command's word turned into the launcher's path, as the terminal's
  shell runs it.
- **`model.ts`**: the models Nova runs on, through Nova's model service, and the variables its
  launcher gets the service in.
- **`ticket.ts`**: the service's tickets, which the runner's Novas share (`NovaTickets`), the
  tour's too.
- **`extension.ts`**: `withNova`, pi's adapter with those models in its extension, which the
  runner's registry uses for agent `pi`.

## Contract

- **Nova is agent `pi`**: on the wire and in storage, Nova's sessions are pi's, told apart by
  their transcripts' folder (`novaSession`) and the extension's mark (`fromNova`). Its folders,
  files and variables are Nova's own: `nova/` under Novadeck's data folder, `shell/nova/`, and
  `NOVADECK_NOVA_*`.
