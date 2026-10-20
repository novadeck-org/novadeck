# Murmur

Murmur is an opt-in local model that writes terminal titles, and two short notes for the
notification list: a headline for a question or plan an agent is waiting on, and a gist of a
reply the person has not seen. (Summaries are the agents' own, written with their `summarize` tool; murmur reads them as the strongest input to a title.) It runs
Qwen3.5-2B (Q4_K_M, 1.28 GB) on llama.cpp's `llama-server`, an engine of its own like
voice input's, installed from Preferences > Addons. Without it, terminals keep their default
titles.

Code: `backend/runner/src/murmur`, the engine build in `engines/murmur`.

## What it reads

Terminals ask for a description when something worth a new one happened (see
`terminals/murmur.ts`) and hand over a digest:

- an agent terminal: the harness, branch, plan, its busiest folders, the person's prompts (the
  first substantial one, then the recent ones, the last being the latest), the tail of the
  agent's last reply, the agent's own summary when it has written one, murmur's previous title,
  and the `stage` of the name: `forming` while the session's work is still taking shape (its
  first turns, or just after a pivot) and `settled` once it has held. The project and folder
  are never shown to the model: the person sits in that project already, so naming it says
  nothing;
- a plain shell: the foreground command and the visible screen rows. The runner says on which
  row the last command was typed (`commandAt`, from the shell integration's prompt report, an
  xterm marker placed at each OSC 7 / OSC 9;9): the rows from it are "the last command and its
  output", the rows above are background (at most six), since a small model otherwise names the
  oldest thing on the screen. Without a row (no shell integration, or the line has left the
  screen or the 30 rows shown) nothing is claimed: the rows are labelled as the screen. Redaction
  keeps every row where it is, so the index holds. The previous title is not shown: a shell is renamed on every command. While a full-screen program draws on the terminal's alternate buffer (vim, less, htop,
  tmux, `kubectl edit`), no screen rows are read at all: the
  program's command line is all murmur gets (the project and folder are never shown), and with no command known
  (Windows has no foreground sampling) it is not asked and the title stays. When the
  program quits, the normal screen is read again. A program that draws on the normal
  screen is read as any screen is: procps `top`, `less -X`, and git's pager, which git runs
  with `LESS=FRX` unless `LESS` is set.

Notes are handed their own digests:

- a headline: the first question an agent asks, with the labels of the answers it offers (at
  most 16), or the start of a plan it asks the person to review (at most 16 KiB);
- a gist: the agent's last reply, whole when short, else its first and last 4000 characters.
  The prompt strips what is no prose, after redaction (fenced code becomes `[code]`, link
  addresses and bare URLs go, table rows become their first row and `[table]`), then budgets
  what is left by what it costs the model in tokens, as a ceiling that does not undercount: 3100 of
  the 4096-token window. A plain word costs 0.65 a character, other ASCII and a digit 1 (and a
  number its leading space, each line break 1, and every word at least 1), Chinese, Japanese and Korean 2 to 2.4, other scripts 1.5 to 3, and
  anything beyond the basic plane 4. It was measured on the engine's own tokenizer against random
  digits, hex, base64, symbols, path lists, emoji and rare characters. That is about 2900
  characters of English each at the start and the end, and far fewer of dense text. Fenced code
  is a line that begins with three or more backticks, up to a line of at least as many, so a
  stray ``` in a sentence is no fence. A request that is still too big for the context (the
  engine answers 400 `exceed_context_size_error`) is a refusal of that job: no text, counted as a refusal for that terminal's kind, and no engine
  failure, back-off or restart. A cut reply is shown as "The start of the agent's reply:", `[…]`, "The end of the
  agent's reply:", so the two pieces are not read as one text.

Nothing else is read, and nothing leaves the machine: the server listens on `127.0.0.1`
behind a random API key made for each launch and passed in the environment
(`LLAMA_API_KEY`).

## Guardrails

- **Redaction** (`redact.ts`): every digest string loses its secrets before the model sees
  it, by the fixed rules of `@novadeck/secrets`, which find them by shape alone (see
  [its README](../libraries/secrets/README.md) for what they cover and miss). A screen's rows
  go through `redactScreen`, so a token split across wrapped rows is still found.
  - The length caps apply after redaction, in the prompt, so a cut token's prefix can't leak.
    Permission commands are never in a digest.
- **Worker thread** (`prepare.ts`, `worker.ts`, on the runner's `thread.ts`, which saved
  transcripts' redaction shares): redaction is a large set of regexes, so it
  never runs on the runner's event loop. Each digest, or note digest, is redacted and turned into the chat in a
  worker thread, with a deadline of about 1.5 s. A digest that overruns ends the thread (the
  only way to stop a stuck regex) and is dropped as "did not run": only that terminal is held
  off for a while, and the others carry on. A thread that will not start at all backs murmur
  off and shows on the card. The install check's test terminal goes through the worker too,
  so a broken worker fails the install. `thread.ts` holds the mechanics both users share: finding
  the script (`murmurWorker.js` or `worker.js` beside the built file, else `worker.ts` through
  tsx), the ready handshake, one job at a time, the deadline, the idle end and the stop.
- **Titles are short noun names**, like a ticket or a branch ("Webhook key rotation",
  "EMO-118 login", "Git history"), asked for as 1 to 3 words. They name what an agent's session
  works toward (the person's substantial prompts, the summary, the plan and the reply), not its
  latest step, and what a shell's window shows (a file tree, failing tests, a dev server), not
  that a command runs: never "Running X", "Review X" or "Help with X".
- **Validation** (`description.ts`): the reply must be JSON with a title of 1 to 4 words and
  at most 32 characters (2 to 10 characters in a script written without spaces). An agent's
  reply also carries a boolean `changed`; a shell's has none and counts as changed. The
  project's name, as the folder spells it, is taken out of a title (one token, any case or accent,
  also as a possessive such as `Novadeck's`, with the joiners it leaves at the edges; a title that
  began with a capital begins the rest with one, except a word lower case by design like `pnpm`
  or `iOS`), unless it is a generic
  word (`app`, `api`, `ui`, `web`, `docs`, `src`, ...) or three letters or fewer; a title that is
  only the project's name is refused. A leading verb filler ("Working on", "Help with", "Review
  of", "Updating"; not "Running", which is content for `docker ps`) is taken off when real words remain ("Fixing login" is kept), and a
  title made only of chat or filler words (Help, Done, Status, Review, Working on, ...) is
  refused. Anything else is dropped. A headline is 2 to 10 words and at most 56
  characters, and may end in `?`. A gist is 3 to 10 words and at most 60 characters (two lines of the sidebar), comes with a
  boolean `asks`, and is refused if it ends in `?` or opens like an English question put to someone (`Should I`, `Do you`, `Can we`) (the question is `asks`' to carry). Notes are
  refused like titles for chat words, a copy of a prompt example (the example itself, or a part
  of it that the digest does not say, in any inflection and by whole words: "awarie" says "Awaria", "monkey" does not say "key") and `looksSecret`. Format characters (bidi overrides,
  zero-width characters) and C1 controls are stripped first, so a title shows what it says.
- **Asking**: `asks` is true when the reply ends by asking the person to pick, decide or supply
  something the agent needs to go on, with or without a question mark. An offer to do more
  ("Want me to...?", "Should I also...?") is not asking. A headline for a question opens with
  "Asks" and one that opens with `Should`, `Can`, `Is` and the like is refused.
- **Room in the schemas**: each schema's `maxLength` is 32 above the parser's limit. The engine's
  grammar cuts a string at the schema's length, which would turn an overrun into a cut phrase that
  passes; with room it comes out whole and is refused. The schema puts `asks` before the gist and
  an agent's `changed` before its title, as the engine's grammar writes properties in order: the
  model decides before it names.
- **Stability**: an agent's previous title goes in the prompt with the stage. While the name is
  `forming`, a better name may replace it, and `changed` is true when the title names different
  or clearer work. Once `settled`, the prompt shows only the latest prompt against the name, and
  `changed` is true when it starts a different feature, bug or area; a follow-up, fix, test,
  review or next step of the same work is not a change. The service then adds a guard: a settled
  verdict of changed stands only if the new title shares no content word with the previous one
  (`sharesContentWord` in `description.ts`: ticket ids such as `EMO-118` whole, other words by
  their stems with plural, `ing`, `ed` and `ion` stripped, ignoring case, accents and the function
  words of English, Polish, German, French and Spanish; generic work
  words (test, bug, fix, update, ...) count for nothing and two-letter acronyms like `UI` count; a
  script without spaces is compared by character pairs, half of the shorter title's being shared), since the 2B model calls a sub-topic "different" far too often. A first title and a
  shell's are always changed. The model's title and verdict otherwise go to the terminals side
  as they are; it decides what to store (see `terminals/murmur.ts`).
- **Prompt** (`prompt.ts`): the current prompt comes last and is labelled. The size is
  capped to fit the 4096-token window.

## Known limits

- The split of a shell's screen rests on the shell integration's prompt report. Where there is
  none (a shell it is not installed in, or one that does not report), the rows are shown as the
  screen with no split, and titles lean on whatever the model reads last. On Windows, ConPTY
  passes the OSC 9;9 report through apart from the frames it renders and repaints the screen
  on a resize rather than letting it reflow, so the row there is best effort.
- The 2B model's `changed` verdict follows the wording of the instruction more than the work.
  Measured through the terminals side's stage machine on 38 real sessions and 8 synthetic ones
  (two real sessions joined at a topic change), per settled strategy: pivots caught within two
  turns on the synthetic ones, false renames on the real ones after the third check (old prompt:
  221): "keep unless clearly other work" 0/8, 41; "different feature, bug or area" 6/8, 118;
  that plus the shared-word guard (shipped) 5/8, 87; free naming with no previous name shown and a
  pivot whenever the new name shares no word with the old 8/8, 136. None pivots without also
  renaming follow-ups; a hard signal (summary, branch or plan change) is the reliable pivot.
- A project name is taken from the project's folder, so `novadeck-website` is stripped from a
  title whole ("Scaffold novadeck-website" becomes "Scaffold"), but not a title that holds only
  the first part ("Novadeck" for that project).
- Titles that echo the typed command (`pnpm test`, `sleep 15`) still come out for a shell
  whose output says little. A shell right after an agent exits is not described until its next
  entered command, so the agent's leftover screen names nothing.
- Redaction is best effort, and weakest on a narrow pane that splits a secret across rows.
  Rows that run to the pane's edge are read together with the next; a group that redacts
  differently as one is masked whole (so a neighbouring row can go with a secret). A quote left
  open across rows that did not run to the edge is not followed. Key blocks are masked from the
  first BEGIN marker to its END, or to the end of the screen.
- An output guard backs it up (`looksSecret`). Murmur writes only short lines, and a title,
  headline or gist is refused (as no text) if it holds a mask, if it has a provider's key in its documented shape,
  if redaction masks a piece of it that looks like a key or is 12 or more characters with a
  digit, or if a piece of a word looks like a key (12 or more characters mixing letters and
  digits with no long run of lower case, or high entropy; a long hex run is one too). Lines
  with ordinary numbers ("Fix PR 131", "Upgrade to Node 26") pass.
- Notes are for the person only: they ride on a terminal's activity to the UI and are never in
  an agent-facing listing or tool.
- Everything stays on this machine: the digest goes to a server on `127.0.0.1` behind a key
  made for the run, and nothing is sent anywhere else.

## Device policy

Murmur needs graphics hardware (a GPU, integrated or not); there is no CPU mode. People are never told "GPU": the app says "this computer". `llama-server --list-devices` prints each device
with its kind (`igpu`, `gpu`, `cpu`, `accel`; Novadeck's patch adds the kind). Candidates are
integrated GPUs first, then dedicated ones, never the CPU, picked by kind and never by index.
`cpu` is never listed by llama-server in practice, and Metal always reports `gpu`, so on Apple
silicon the check records `integrated: false`.

The install check runs a fixed test description on each candidate in that order and keeps
the first that returns a valid one. The result (`device` name, `integrated`, `milliseconds`)
is saved. Launches find that device again by name, as indexes differ between boots. The devices
are listed before the model is downloaded, so a computer with no candidate never downloads the
1.28 GB.

Only a real incompatibility becomes a verdict, and only three things are one:

- `--list-devices` ran and listed no candidate device;
- every device the check tried answered with no usable title (a reply that is no JSON title);
- the engine could not load a library it needs (`error while loading shared libraries`,
  `cannot open shared object file`, or Windows' missing-DLL exit).

Everything else stays an ordinary failure with Try again, and keeps the downloaded model: a
timeout (`startMs`, the request time, `checkMs`, the 30 s of `--list-devices`), an
out-of-memory or load failure (another program may hold the video memory), a crash, a failed
start of any other kind, a spawn error, an error answer, an answer cut off, and a mixed result
(one device unusable, another timed out). On a verdict the runner removes the engine and the
model, saves the reason with the sha of the engine build that ran, and shows `unsupported` in
the state (`unsupported: { reason, source: "check" }`). Preferences then says "Not available on this computer" with the
reason behind Details, and the offer never comes up. An app update with another engine sha
forgets the verdict by itself; Check again, inside Details, installs again, which clears the
verdict and checks anew; until that check passes the old verdict stands, through a cancel or a
failure. The host also tells the runner at start (`--novadeck-graphics=software`, shared with
voice input) when Electron's `app.getGPUInfo("basic")` lists only
software adapters (SwiftShader, llvmpipe, WARP), so the same state shows before any download;
that verdict is the host's word, is not saved, is `source: "host"` (so no Check again), and an
unsure answer counts as capable. Apple silicon always does. It gates offering and installing
only: an installed and checked murmur keeps working.

If a later launch finds the engine doesn't list the checked device (it may list none), the check
is dropped and `failure` says "The graphics device murmur was checked on isn't there now.". The
UI then derives "unchecked" (below), which Try again (an install) answers by running just the check.

## The card's state

Installed with no passed check and nothing running (a check the person cancelled, a restart
after a failed one, or a check dropped because its device went away) is `installed: true,
check: null`, which the UI derives as "unchecked" (`unchecked(state)` in `core/murmur.ts`; it
is not on the wire). It has no `failure` of its own: a cancel is no failure (if something else
went wrong, `failure` is set too and is what the card shows). Install again runs just the check.
`failure` is only what the runner says: a failed install or engine update, until the next one;
while murmur runs, the worker thread that won't start or three engine failures in a row (a crash
or no answer in time), until the next job that succeeds or murmur is turned on. The check is
kept in those cases. A call the backend refused is the adapter's word, apart from `failure`
(`refused` in the UI's state, until the next snapshot). `installing.origin` says who started the
job: `"person"`, or `"update"` for the app's own engine update, which shows nothing.

`offers` counts the sessions of the app the one-time offer was shown in. The app reports one
with `murmur.noteOffered()` when the chip is drawn (`takeAddonOffer("murmur")`), and the offer
stops after three.

## Being polite

- It loads on the first job and unloads after about two minutes idle.
- One job at a time, never pre-empted. Jobs wait in a line served by kind: headlines first, then
  gists, then titles, first come first served within a kind. A job whose signal aborts leaves the
  line. A title may wait behind headlines: that is meant.
- Gists are written only for a finish a window marks unread (the UI asks with `murmur.gist`), and
  a headline when a question or plan is asked, so murmur does no work for text no one will read.
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
  seconds, doubling with each failure in a row up to eight minutes, for every kind of job. A
  digest that overruns the worker's deadline holds off only its own terminal, the same way, and so
  does a terminal whose texts keep being refused, each kind counted apart (a terminal whose
  headlines are refused still gets titles and gists). A passing check, and turning
  murmur on, forget all of it.
- A job stopped because murmur was turned off is not a failure.
- Turning murmur off, or uninstalling it, clears the titles, headlines and gists it wrote (`watchCleared` in the
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
(`fail:<device>`, `crash`, `slow`, `hang`, `garbage`, `copy`, `device`, `project`, `same`, `overflow`,
`late`, `log`; a mode is found anywhere in the text, so names must not contain one another); it
reads the file again at each request, so a test can mend a running server. It answers by the
`response_format.json_schema.name` it is asked with (`agent_title`, `terminal_title` for a shell, `request_headline`,
`reply_gist`), and `copy` copies the first example of that kind. The reply to `agent_title` also
carries `changed` (true; `same` makes it false); a shell's has the title alone. `project` writes a
title that opens with the project "shopdeck". The model is
installed as `models/<first 12 of its sha256>-<name>`, and other files there are removed
after a model install. `testing/slow-worker.mjs` and `testing/regex-worker.mjs` stand in for the
redaction thread (a spinning loop, and a regex that backtracks without end); they speak
`thread.ts`'s protocol (`{ id, request }` in, `{ id, result }` or `{ id, failed }` out). `murmur/real.test.ts`
runs the real engine when `NOVADECK_MURMUR_REAL_ENGINE` (an unpacked engine folder) and
`NOVADECK_MURMUR_REAL_MODEL` are set; it writes a title, a headline and a gist. Title-only jobs take 2 to 6 s warm on an Arc iGPU.

llama-server's flags are built by `serverArguments` and pinned by a test. Changing them, or the
HTTP surface murmur uses, means bumping `engineInterface` in
`engines/murmur/scripts/build.ts`.
