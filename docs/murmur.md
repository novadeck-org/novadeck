# Murmur

Murmur is an opt-in local model that writes terminal titles. (Summaries are the agents' own, written with their `summarize` tool; murmur reads them as the strongest input to a title.) It runs
Qwen3.5-2B (Q4_K_M, 1.28 GB) on llama.cpp's `llama-server`, an engine of its own like
voice input's, installed from Preferences > Addons. Without it, terminals keep their default
titles.

Code: `application/runner/src/murmur`, the engine build in `application/murmur`.

## What it reads

Terminals ask for a description when something worth a new one happened (see
`terminals/murmur.ts`) and hand over a digest:

- an agent terminal: the harness, project, folder, branch, plan, its busiest folders, the
  person's prompts (the last one is the current one), the tail of the agent's last reply, the
  agent's own summary when it has written one, and murmur's previous title;
- a plain shell: project, folder, the foreground command, the visible screen rows and the
  previous title. While a full-screen program draws on the terminal's alternate buffer (vim, less, htop,
  tmux, `kubectl edit`), no screen rows are read at all: the
  program's command line, folder and project are all murmur gets, and with no command known
  (Windows has no foreground sampling) it is not asked and the title stays. When the
  program quits, the normal screen is read again. A program that draws on the normal
  screen is read as any screen is: procps `top`, `less -X`, and git's pager, which git runs
  with `LESS=FRX` unless `LESS` is set.

Nothing else is read, and nothing leaves the machine: the server listens on `127.0.0.1`
behind a random API key made for each launch and passed in the environment
(`LLAMA_API_KEY`).

## Guardrails

- **Redaction** (`redact.ts`): fixed rules strip secrets from every digest string before the
  model sees it, by shape alone. They cover provider keys and tokens (`sk-`, `sk_live_`,
  `ghp_`, `github_pat_`, `glpat-`, `hf_`, `hvs.`, `npm_`, `pypi-`, `AIza`, `AKIA`, `xox`,
  `AGE-SECRET-KEY-`), JWTs, `Authorization`, `Cookie` and bearer values, webhook URLs, URLs with
  `user:password@` (also with an empty user) and secret query parameters, key blocks,
  `NAME=value`, `name: value` and `"name": "value"` when the name sounds secret, exact
  secret flags (`--password`, `--token`, `--api-key`, ...), `mysql -p`, `docker login -p`
  and `curl -u`, and long hex or base64 runs.
  - A name sounds secret by its words: `secret`, `password`, `token`, `pass`, `pwd`, an `api`,
    `private` or `access` before `key`, and so on. `KEY_COUNT`, `token_count`,
    `PRIMARY_KEY`, `auth=required`, `sessionId` and `--sort-key` are not secrets. Values that are
    paths, short numbers or words like `true` are kept.
  - Base64 never matches inside a path, and needs digits, mixed case and no long word, so
    identifiers and paths survive. Commit ids (40 hex) and `sha256:` digests are kept.
  - A terminal wraps long lines, so a token split across rows is still found; the row after a
    wrapped token may be removed with it.
  - The length caps apply after redaction, in the prompt, so a cut token's prefix can't leak.
    Permission commands are never in a digest.
- **Worker thread** (`prepare.ts`, `worker.ts`): redaction is a large set of regexes, so it
  never runs on the runner's event loop. Each digest is redacted and turned into the chat in a
  worker thread, with a deadline of about 1.5 s. A digest that overruns ends the thread (the
  only way to stop a stuck regex) and is dropped as "did not run": only that terminal is held
  off for a while, and the others carry on. A thread that will not start at all backs murmur
  off and shows on the card. The install check's test terminal goes through the worker too,
  so a broken worker fails the install.
- **Validation** (`description.ts`): the reply must be JSON with a title of 2 to 6 words and
  at most 48 characters. Anything else is dropped. Format characters (bidi overrides,
  zero-width characters) and C1 controls are stripped first, so a title shows what it says.
- **Stability**: the previous title goes in the prompt, with the instruction to keep it
  unless the work clearly changed.
- **Prompt** (`prompt.ts`): the current prompt comes last and is labelled. The size is
  capped to fit the 4096-token window.

## Known limits

- Redaction is best effort, and weakest on a narrow pane that splits a secret across rows.
  Rows that run to the pane's edge are read together with the next; a group that redacts
  differently as one is masked whole (so a neighbouring row can go with a secret). A quote left
  open across rows that did not run to the edge is not followed. Key blocks are masked from the
  first BEGIN marker to its END, or to the end of the screen.
- An output guard backs it up (`looksSecret`). Murmur writes only a title, and a title is
  refused (as no title) if it holds a mask, if it has a provider's key in its documented shape,
  if redaction masks a piece of it that looks like a key or is 12 or more characters with a
  digit, or if a piece of a word looks like a key (12 or more characters mixing letters and
  digits with no long run of lower case, or high entropy; a long hex run is one too). Titles
  with ordinary numbers ("Fix PR 131", "Upgrade to Node 26") pass.
- Everything stays on this machine: the digest goes to a server on `127.0.0.1` behind a key
  made for the run, and nothing is sent anywhere else.

## Device policy

Murmur needs a GPU; there is no CPU mode. `llama-server --list-devices` prints each device
with its kind (`igpu`, `gpu`, `cpu`, `accel`; Novadeck's patch adds the kind). Candidates are
integrated GPUs first, then dedicated ones, never the CPU, picked by kind and never by index.
`cpu` is never listed by llama-server in practice, and Metal always reports `gpu`, so on Apple
silicon the check records `integrated: false`.

The install check runs a fixed test description on each candidate in that order and keeps
the first that returns a valid one. The result (`device` name, `integrated`, `milliseconds`)
is saved. Launches find that device again by name, as indexes differ between boots. The devices
are listed before the model is downloaded: with no candidate the install fails saying murmur
needs a working GPU, without the 1.28 GB download. When candidates all fail the check, the
failure keeps the last device's own words. If the engine can't list devices at all, the failure
says what it printed last.

If a later launch finds the engine doesn't list the checked GPU (it may list none), the check is dropped and
the card shows "The GPU murmur was checked on is gone. Try again."

## The card's state

Installed with no passed check (a cancelled check, or a restart after a failed one) is shown as
`installed: true, check: null` with `failure` set to a message ending in "Try again." Install
again runs just the check. `failure` is also set for a failed install or engine update, and
clears on the next one. While murmur runs it is set when the worker thread won't start or after
three engine failures in a row (a crash or no answer in time), and clears on the next job that
succeeds or when murmur is turned on. The check is kept in those cases.

## Being polite

- It loads on the first job and unloads after about two minutes idle.
- One job at a time. A job whose signal aborts is dropped.
- Voice input has priority: while `voice.activity.busy()`, murmur aborts its request, waits,
  and retries.
- A cold start (no model loaded) waits while the computer's free memory, or the chosen device's,
  is under about 2 GB. Free device memory stands in for "the GPU is busy". Once the model is
  loaded its own memory is not held against it, so a warm job is never held back by these. On
  macOS free system memory comes from `vm_stat` (the OS counts only never-used pages as free,
  so `os.freemem()` would always look short), and the device's figure is skipped, as Metal's
  is this process's own working set.
- A request that gets no answer in a minute counts as a failure and the engine is restarted.
- After a failed job, or when the engine can't list the devices, murmur refuses jobs for 30
  seconds, doubling with each failure in a row up to eight minutes. A digest that overruns the
  worker's deadline holds off only its own terminal, the same way. A passing check, and turning
  murmur on, forget all of it.
- A job stopped because murmur was turned off is not a failure.
- Turning murmur off, or uninstalling it, clears the titles it wrote (`watchCleared` in the
  describer, consumed by the terminals), also from the store's files on disk, as the store does with
  anything it forgets. A failed check, a lost GPU or the runner closing do not.
- It runs on battery.

## Configuration

- `NOVADECK_MURMUR_ENGINE`: the engine's manifest (`engine.json`).
- `NOVADECK_MURMUR_SOURCE`: where its archive is, an https URL ending in `/` or a folder.
- The engine and model install in `<database folder>/murmur`.

The desktop app passes `--novadeck-murmur-engine=` and `--novadeck-murmur-source=` to the
runner; packaged, the manifest is at `resources/murmur/engine.json`.

## Testing

`testing/fake-llama.mjs` stands in for `llama-server`; the model file's contents steer it
(`fail:<device>`, `crash`, `slow`, `hang`, `garbage`, `copy`, `device`, `late`, `log`); it
reads the file again at each request, so a test can mend a running server. The model is
installed as `models/<first 12 of its sha256>-<name>`, and other files there are removed
after a model install. `testing/slow-worker.mjs` and `testing/regex-worker.mjs` stand in for the
redaction thread (a spinning loop, and a regex that backtracks without end). `murmur/real.test.ts`
runs the real engine when `NOVADECK_MURMUR_REAL_ENGINE` (an unpacked engine folder) and
`NOVADECK_MURMUR_REAL_MODEL` are set. Title-only jobs take 2 to 6 s warm on an Arc iGPU.

llama-server's flags are built by `serverArguments` and pinned by a test. Changing them, or the
HTTP surface murmur uses, means bumping `engineInterface` in
`application/murmur/scripts/build.ts`.
