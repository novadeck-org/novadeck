# End-to-end tests

The end-to-end suite runs the real Claude Code, Codex and Antigravity TUIs in
Novadeck's terminals, with Novadeck's real plugin, hooks and MCP server, against a
scripted fake model. It checks agent messaging the way people use it, with real
harnesses: an agent calls `send`, Novadeck rings the idle recipient, and the reply comes
back. The model is the one part replaced, so runs need no credentials, cost nothing and
give the same result every time.

## Running

The suite runs on Linux only. Its keyring cut is a dead D-Bus address, which doesn't
keep a harness from the macOS Keychain, and its leftover-process check reads `/proc`.
On anything else the fixture fails each test, saying so; a scenario file can skip
instead with `describe.skipIf(!supported)`, `supported` coming from `fixture.ts`.

```sh
npm run test:e2e                  # from the repository root; builds the protocol and relay first
pnpm --filter @novadeck/protocol --filter @novadeck/relay build
pnpm --filter @novadeck/runner test:e2e
NOVADECK_E2E_AGENTS=claude pnpm --filter @novadeck/runner test:e2e   # one harness
```

The runner's own script doesn't build `@novadeck/protocol` or `@novadeck/relay`, which
agents start for Novadeck's MCP server and hooks, so build them first when running the suite
from `application/runner`, as the root script does.

The first run installs the pinned harnesses (a few hundred MB). Later runs reuse them.
Each `e2e(...)` installs its harnesses once, before its tests, so a download counts
against the hook timeout (ten minutes) rather than a test's. A harness left out of
`NOVADECK_E2E_AGENTS` is neither installed nor run.

`npm run test` never runs the suite: its files end in `.e2e.ts`, and only
`application/runner/vitest.e2e.config.ts` includes them. The unit tests for its parts
(`src/e2e/**/*.test.ts`) run with the rest.

| Variable                      | Effect                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `NOVADECK_E2E_CACHE`          | Where harnesses are installed. Defaults to `$XDG_CACHE_HOME/novadeck/e2e`, or `~/.cache/novadeck/e2e` without XDG_CACHE_HOME |
| `NOVADECK_E2E_HARNESS=latest` | Installs and runs each harness's newest release instead of its pin, as a drift check                                         |
| `NOVADECK_E2E_AGENTS`         | The harnesses to run, comma-separated (`claude`, `codex`, `agy`); all when unset. `selected(setup)` in `fixture.ts` reads it |

In CI (`.github/workflows/e2e.yml`) each harness runs in a job of its own, which runs
the whole suite with `NOVADECK_E2E_AGENTS` set to that harness, so the scenarios across
harnesses skip there. A `Mixed` job sets it to `claude,codex,agy` and runs only those,
the files ending in `.mixed.e2e.ts`, leaving the rest to the jobs of one harness. Each
harness's pinned installs are cached on their own, keyed by that harness's entry in
`harnesses.json` and by `install.ts`, so moving one pin leaves the others' caches alone,
and its own job and the mixed one share them: its `<cache>/<harness>-*` folders, without
unfinished staging (`*.tmp`), npm's own cache (`<cache>/home`) or anything else there. A
job restores the cache of each harness it runs. Unless the run was cancelled, one it
missed is saved even when the tests fail, so the next run needn't install again, but only
once a `<cache>/<harness>-*` folder holding the harness's program exists: a failed or
cancelled install saves nothing under the key.

## What is pinned

`application/runner/src/e2e/harnesses.json` pins each harness's release:

| Harness     | Published as                                          | Version |
| ----------- | ----------------------------------------------------- | ------- |
| Claude Code | npm, `@anthropic-ai/claude-code`                      | 2.1.287 |
| Codex       | npm, `@openai/codex`                                  | 0.159.3 |
| Antigravity | an archive, by its address and SHA-512 (Linux x86-64) | 1.2.14  |

`install.ts` installs each harness into `<cache>/<harness>-<version>`, staging it first
in a folder with a random name so an interrupted install never counts as done, and
returns the folder holding its program. Should another run finish the same version
first, its folder is kept, as that run may be using it, and the staging is discarded;
an installed folder is never removed. A folder there without its program fails the
install, naming the folder to delete. Within a process each harness is installed once,
and `latest` looked up once. npm is the one beside the node running the tests, or the
first on PATH, and the install fails saying so when there is none. npm runs with a home
inside the cache (`<cache>/home`, which also holds npm's own cache) and a dead D-Bus
address, so neither npm nor a package's install script reads or writes the developer's
home or reaches their keyring. A version from `npm view`, from Antigravity's manifest or
from a pin must match `^[\w.+-]+$` before it names a folder. Antigravity isn't on npm: its archive is
downloaded from the address its own installer's manifest gives, checked against the
pinned SHA-512 before anything of it runs, and only its program is kept, as `agy`. With
`NOVADECK_E2E_HARNESS=latest` it reads that manifest for the newest release instead. A
copy of a harness installed anywhere else on the machine is never used. To move a pin,
change it and run the suite.

## Isolation

The suite never runs a harness against the developer's configuration, login or
network:

- **A sandbox per test.** `sandbox.ts` makes a throwaway root under the system's
  temporary folder, with a home, a project, XDG folders and a private `XDG_RUNTIME_DIR`.
  Every process the test starts gets only the sandbox's environment, with nothing copied
  from the developer's. Its PATH is the pinned harnesses, a folder holding just `node`,
  and `/usr/bin:/bin`. The deck gives the runner's terminals the sandbox's environment
  as their `baseEnv`, so they don't start from the runner's own as they do in the app,
  and runs plugin commands with it as it is (`createHarnesses`'s `login: false`), so no
  login shell's startup files, `/etc/profile` included, can put another PATH first.
- **No keyring.** `DBUS_SESSION_BUS_ADDRESS` points at a socket that doesn't exist, so
  no harness finds a login in the secret service. The kernel keyring (keyutils) needs no
  bus, so for each pinned harness it was checked, from its source or its program's
  strings, which store it reads and by what name:
  - Claude Code 2.1.287 keeps its login in `.credentials.json` under `CLAUDE_CONFIG_DIR`,
    and Anthropic profiles under `ANTHROPIC_CONFIG_DIR` or `~/.config/anthropic`. Only
    on macOS does it use a keyring, the Keychain, through `security`. Both folders are
    in the sandbox. Its program names `secret-tool` only in its Bash tool's deny rules.
  - Codex 0.159.3 keeps its login in `$CODEX_HOME/auth.json` by default
    (`cli_auth_credentials_store = "file"`). Set to `keyring` or `auto`, it uses the
    `keyring` crate's Linux store, which caches the secret service in the kernel keyring,
    so the dead bus doesn't keep it out. The entries are named after a hash of the
    canonical `CODEX_HOME` (`keyring-rs:cli|<hash>@Codex Auth`, `secrets|<hash>@codex`),
    so a Codex with the sandbox's home looks up names the developer's Codex never wrote.
    MCP OAuth tokens are named only after the server's address
    (`Codex MCP Credentials`), but only HTTP MCP servers have them, and the sandbox
    configures none: Novadeck's server runs over stdio.
  - Antigravity 1.2.14 uses `zalando/go-keyring`, which on Linux only talks to the
    secret service over D-Bus. Its program has no `keyctl` call.
- **No network.** The fake model is also every process's `HTTP(S)_PROXY`, with
  `NODE_USE_ENV_PROXY=1` so Node's own `fetch` takes it too. It refuses each tunnel and
  each request for another server and records its host, never its path. Only loopback
  is exempt. On its own, that blocks egress only for programs that honour the proxy. In
  CI the suite also runs in a network namespace whose only interface is loopback
  (`scripts/e2e/isolated/main.ts`), so a program that connects directly has no route out
  either, and the proxy still records the hosts the harnesses tried. The harnesses are
  installed before that, outside the namespace, by `scripts/e2e/install/main.ts`, which
  installs those `NOVADECK_E2E_AGENTS` names into the cache as the suite would; the
  suite's own install then finds them done. Every CI job runs this way, the nightly one
  against `latest` included: with `NOVADECK_E2E_HARNESS=latest` the pre-install records
  the newest version it resolved in the cache, and the run inside the namespace reads it
  there instead of looking it up. To run the suite the same way locally:

  ```sh
  pnpm --filter @novadeck/protocol build
  NOVADECK_E2E_AGENTS=claude node scripts/e2e/install/main.ts
  NOVADECK_E2E_AGENTS=claude node scripts/e2e/isolated/main.ts -- pnpm --filter @novadeck/runner test:e2e
  ```

  `isolated` runs a command in the namespace as the user who ran it, with their
  environment. Where sudo needs no password, as on GitHub's runners, root makes the
  namespace (`unshare --net`), brings loopback up and hands the command back to the user
  with `setpriv`; sudo resets the environment, so it passes through a file only the user
  can read, deleted before the command starts. Elsewhere an unprivileged user namespace
  owns it, which Ubuntu 24.04 may forbid
  (`kernel.apparmor_restrict_unprivileged_userns`). `NOVADECK_E2E_NETNS=sudo` or `user`
  picks one. CI always takes `sudo`; `user` is for a developer without passwordless
  sudo, and the opted-in tests below are where it runs, with
  `NOVADECK_E2E_NETNS=user NOVADECK_E2E_NETNS_TESTS=1`. It refuses to run the command if
  the namespace has any interface besides loopback.

- **No real credential.** Each harness gets a fake key that the fake model accepts. A
  request carrying any other credential, in a credential header or a `key` query
  parameter, is refused and counted, and its value is never stored; an empty value, or
  an auth scheme such as `Bearer` with nothing after it, carries none. A request for another server is recorded by its host before it is
  refused, whatever it carried. A foreign credential fails the test, as does any request
  that tried a harness's real API host, and any request a dialect failed on, which the
  fake model records by its method, path and what went wrong (`model.errors`): a parse's
  first issue, by its path and message, "the body is not JSON" for a body that isn't (the
  parser's own message would quote it), or an error message's first line, never the
  request's body or headers. A request a dialect matched but answered 404, an endpoint
  it doesn't serve, is recorded in `model.strays` like one no dialect took.
- **No updates.** Update checks are switched off, and npm's prefix points into the
  sandbox, so a harness that updates itself can't touch a global install.
- **A tripwire.** `tripwire.ts` looks for what a harness that escaped the sandbox would
  leave in the developer's home, in three ways, over the paths each setup lists in its
  `watch`; every test watches every harness's paths. It names only the paths that tripped it, never
  anything it read, and a path absent both times is skipped, so CI, which has none, has
  nothing to check.
  - Configuration files the developer's own sessions rewrite as they start or run are
    read after the test and searched for the sandbox's root, which a connect or trust
    that leaked out would write there; nothing read is kept or printed. These are
    `~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json`,
    `~/.claude/plugins/known_marketplaces.json`, `~/.codex/config.toml` and
    `~/.gemini/antigravity-cli/settings.json`.
  - Folders are searched by their entries' names for the sandbox's: Antigravity's
    `~/.gemini/antigravity-cli/mcp`, which it rewrites as it starts, and Claude Code's
    `~/.claude/projects`, where it names a project after its path.
  - Paths that change only when a plugin is installed or removed, or the person signs in,
    have their modification time and size compared before and after, never their
    contents: `~/.codex/auth.json`, which is never read, `~/.codex/plugins/cache/novadeck`
    (Novadeck's copy among Codex's installed plugins; not the folder itself, where the
    developer's own Codex refreshes its bundled plugins whenever it likes),
    `~/.gemini/config/plugins` (where Novadeck installs Antigravity's plugin), and
    `~/.gemini/antigravity-cli/plugin_data` and `bin`.

  Busy files such as histories, sessions, session indexes, sockets, logs and state
  aren't checked, so a real session beside the tests can't trip it.

- **Checked once the deck closes.** The fixture closes the deck, then runs its checks
  while the fake model still listens, so whatever a harness sends on its way out, such as
  telemetry flushed on exit, counts too; only then does the model close. `reap.ts` also
  looks in `/proc` for processes still running in the sandbox. For each process it reads
  `/proc/<pid>/stat`, for its state and its start, and passes over zombies and any
  process that started before the sandbox was made. Only for the rest does it read where
  `/proc/<pid>/cwd` points, then, unless that is inside the sandbox, `/proc/<pid>/environ`,
  searched only for `HOME=<sandbox home>` and neither kept nor printed, and last
  `/proc/<pid>/comm` for its name. A harness the deck's hangup reached may take a moment
  to exit (Claude Code takes about 200 to 250 ms), so each gets three seconds to end by itself.
  One still running then is ended with SIGTERM, then SIGKILL two seconds later, each
  signal sent only once the process is checked to be the same one, and fails the test,
  named by its command and pid, and marked `stopped` should job control have stopped it.
  It looks again, up to five times, until it finds no process it hasn't seen. Should the
  test end early, its teardown does the same, and fails the test for any process it had
  to end.
- **Enter only on text seen to land.** A deck terminal's `submit` types the text, waits
  until the screen shows it once more than it did before, and only then presses Enter.
  `press` refuses anything holding a carriage return or line feed, the keypad's Enter
  (`\x1bOM`) or the kitty keyboard protocol's (`\x1b[13u`, `\x1b[13;…u`). The one
  deliberate Enter is `confirm(shows, trigger)`. It counts what the screen shows of the
  expected option or dialog, runs `trigger`, the action that brings it up, and presses
  Enter only once the screen shows it once more. Text left from an earlier dialog can't
  let it through, and a dialog drawn before `trigger` returns isn't missed:
  `await t1.confirm("Allow this tool?", () => t1.submit("Run the tool"))`. In a menu,
  `shows` must name what moves with the selection, such as the TUI's cursor marker
  (`/❯ Option/`), not the option's plain text: the rendered screen drops colours, so a
  selection a TUI shows only by highlighting changes no text, and a wrong `shows` only
  times out.
- **A bare Enter on an empty box, mid-turn.** `t.enterEmpty()` is the one other
  deliberate Enter. It presses Enter only while the turn of the prompt the terminal
  last submitted is working, with nothing sent to the terminal since that prompt's
  Enter, so the box is known empty; otherwise it throws, sending nothing.
- **Escape on its own.** `await t.escape()` sends Escape (`\x1b`, or the keys given)
  and resolves only `escapeWindowMs` (1200 ms) later; escapes
  go one at a time, each waiting out the one before, even unawaited. A TUI reads two
  Escapes close together as Esc-Esc, a different command (Claude Code's Rewind picker,
  Codex's backtrack), and a lone ESC byte followed quickly by another key as one Alt
  sequence. Claude Code 2.1.287's Esc-Esc window is about 800 ms: two Escapes 300 or
  700 ms apart opened Rewind, 1000 or 1500 ms apart didn't. Like `press`, it refuses
  Enter. Send Escape through `escape`, not `press`, whenever anything may follow it.

## Writing a scenario

Messaging scenarios live in `messaging.e2e.ts`, a runner restart's in `restart.e2e.ts`,
an agent starting another with a task, or closing another's terminal, in
`tasks.e2e.ts`, the person typing around messages in `person.e2e.ts`, messages that come while the agent waits on the person (a
permission question, its own popup, a picker) in `requests.e2e.ts`, a nested run of the
harness inside an agent's turn in `nested.e2e.ts`, the person forking a session in a new
terminal or in place in `forks.e2e.ts`, the person clearing the conversation
or leaving the agent for another in `lifecycle.e2e.ts`, and the person's controls over
a running agent and untrusted seeds in `controls.e2e.ts`, and the chat view's way to an agent
(`agents.prompt` and `agents.interrupt`) in `chat.e2e.ts`, answering the agent's requests
from the chat (`agents.answer`) in `answers.e2e.ts`, each written once and run for
every harness in `setups` (`agents/index.ts`):

```ts
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("takes a prompt to the model and shows its reply", async ({ e2e: run }) => {
      run.model.use(replies("Say the word", "Pelican-7 says hello."))
      const t1 = await start(run, setup)

      await turn(t1, "Say the word", "Pelican-7 says hello.")

      const call = await run.model.waitFor(
        (one) => !one.side && latest(one).includes("Say the word"),
      )
      expect(tool(call, "send")).toBeDefined()
    })
  })
}
```

- **One rule for parity: a scenario never branches on `setup.agent`.** A difference
  between harnesses is either a trait of its setup (`name`, `banner`, `bindsAtReady`,
  `refused`, `interrupted`, `approval`, `background`, `trust`, `shell`, `rewind`,
  `popup`, `fork`) or a known gap in
  `known-gaps.ts`, which picks the documented detour (see [Known gaps](#known-gaps)). A
  `<harness>.e2e.ts` holds only what is truly that harness's own, such as Codex's logo
  on its first screen, its `/side` conversation and its spawned agent's dialog
  (`codex.e2e.ts`), or a known gap's pin.
- **Traits a harness may not have** (`approval`, `background`, `trust.folder`,
  `trust.hooks`, `rewind`, `popup`, `shell`, `fork.picker`, `fork.inPlace`) gate the scenarios that need them: `gated(it, lacking(setup, "approval"))`
  runs the test, or skips it with its name saying which trait the harness lacks and why.
  Skip on a trait, never on a harness's name. A missing trait means the harness doesn't
  have the behaviour at all, as Claude Code has no hooks review, and its setup says so in
  `absent`, with what a probe of the pinned version found, as Codex's `background` does:
  `absent: { background: "nothing it starts wakes it once its turn has ended (probed
2026-10-02, 0.159.3)" }`. `lacking` fails on a missing trait with no reason there. A
  missing trait never stands in for a gap: a behaviour the harness has that Novadeck
  doesn't yet support the same way is a gap, recorded in `known-gaps.ts` and raised as a
  blocker (see [Known gaps](#known-gaps)).

  ```ts
  gated(it, lacking(setup, "approval"))("asks before a tool runs", async ({ e2e: run }) => {
    run.model.use(answers("Make the file", (call) => setup.approval!.request(call)))
    const t1 = await start(run, setup)
    await t1.confirm(setup.approval!.shows, () => t1.submit("Make the file"))
  })
  ```

  - `approval`: `request(call)` is a reply calling a tool the harness asks about first,
    as seeded; `shows` matches its question with the allowing option selected, for
    `confirm`; `deny` is the keys that refuse it, pressed without Enter, other than
    Escape where the harness has such a key, so Novadeck learns of the refusal from the
    harness rather than the keystroke; `denied` is what the screen then shows of it.
  - `interrupted(prompt)`: what the screen shows once Escape interrupted the turn of
    `prompt` before its reply came, the harness's own account; required, as the Escape
    scenario runs for every harness.
  - `background`: `start(call)` is a reply starting work that outlives the turn (a
    background subagent or task) whose end wakes the agent again; `owns(call)` tells
    that work's model calls from the agent's own, so a rule can hold them at a `gate()`.
  - `trust.folder`: `{ shows, select, trusts, probe? }`, its folder-trust question as
    `folderTrusted: false` shows it: text it shows whatever is selected, the keys that
    select the trusting option (`""` when the question shows it selected), and that
    option as shown selected, for `confirm`. `probe` (`{ away, moved }`) is for a TUI
    that draws the question before it reads keys: another option is selected until the
    screen shows it moved, and `select`, which can't then be `""`, puts it back.
  - `trust.hooks`: `{ shows, skip }`, its hooks-review screen and the keys that leave it
    without trusting Novadeck's hooks, as `hooksTrusted: false` shows it.
  - `rewind`: `{ shows, swallows }`, what Esc-Esc (two Escapes about 300 ms apart, sent
    with `press`) opens at its idle prompt, a picker or mode for going back to an earlier
    prompt, and whether it swallows a paste (`true`: the ring fails) or is left by it, the
    paste landing in the prompt (`false`: the ring delivers).
  - `popup`: `{ reply(text), shows }`, a reply ending the turn with `text` that makes the
    harness raise a popup of its own once the turn has ended, through what the API
    reports beside it (the reply's `usage` or `limits`), and what that popup shows, as
    seeded `popup: true`.
  - `shell`: `{ run(call, command), nested(prompt) }`, a reply having the agent run
    `command` through its shell tool, and the command running the harness itself once,
    non-interactively, on `prompt` (`claude -p`, `codex exec`, `agy -p`), which its seed
    lets run without asking, unlike `approval`'s. The nested run inherits the agent's
    environment, so it reaches the fake model, and its own hooks report to Novadeck.
  - `fork.picker`: `{ command, picked(prompt) }`, the command that, in a new terminal,
    shows a picker of the project's sessions, latest first and selected, Down selecting
    the next, and forks the one picked; `picked` matches the row of the session whose
    first prompt was `prompt` as selected, for `confirm`.
  - `fork.inPlace`: the command, typed at its prompt, that forks its conversation in the
    same terminal, the harness then naming the fork as a new session.

- **Seeds.** `e2e(setup)` starts each harness trusted and straight at its prompt.
  `e2e.seeded(seed, ...setups)` seeds every setup of the test otherwise, through
  `prepare(sandbox, model, installed, seed)` and `connected(sandbox, model, seed)`:
  `{ folderTrusted: false }` leaves the project folder untrusted, so the harness asks
  first, and `{ hooksTrusted: false }` leaves Novadeck's hooks untrusted where the
  harness has that step (Codex), so they don't run. `{ popup: true }` seeds the account
  as one the harness's `popup` shows for, where it shows it only for some (Claude Code's
  cost warning, only for a billing admin); no other test gets that account. A seed holds
  for every terminal of the test, as both are settings of the project; a harness with no such step ignores it.
  A seeded test goes in its own `describe`, as `e2e.seeded` gives its own `it`.
- `e2e(...setups)` gives each test a fake model, a sandbox and a deck, with each
  setup's harness installed (once, before its tests), seeded and connected to Novadeck
  through its own plugin commands. With several setups, as for a scenario across
  harnesses, their dialects share one fake model, and the tests run only when every one
  of their harnesses is selected. Such scenarios go in files ending in `.mixed.e2e.ts`,
  which CI's mixed job runs alone; `messaging.mixed.e2e.ts` passes a message round a
  ring of every harness, each hop's recipient rung for it.
- **The fake model** answers each call with the first rule that replies; `model.use`
  adds rules ahead of the earlier ones, and with none it answers "OK.". Rules may be
  async: a rule that awaits a `gate()` holds its reply, and so keeps that turn running,
  until the test calls `open()`. The call is recorded as it arrives, before any rule
  answers. A `Call` is the same shape for every API; its latest user turn includes what
  a hook added beside the prompt, and `side` marks a call the harness makes for itself,
  such as a title. `model.mark()` and `waitFor(match, { after })` wait only for calls
  made after a point, so a second call of the same kind isn't mistaken for the first.
  A `Reply` may also say what the API reports beside it, for a harness that acts on it:
  `limits: { usedPercent }`, the share of the account's rate limits used, as the
  Responses API's `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`
  headers carry it (a five-hour and a weekly window, each resetting a window from now);
  and `usage: { outputTokens }`, the output tokens the Messages API reports for it in
  place of the dialect's own count. A dialect whose API reports neither ignores them.
- **Helpers** in `scenarios.ts` make most scenarios a few lines: `start` opens a
  terminal and waits for Ready and then `prompted`, its `banner` on screen with no
  startup question (folder trust, hooks review) left. Ready alone doesn't say the
  prompt reads keys: a harness can report its session before its prompt draws, while
  the terminal still echoes what's typed, and `submit` would take the echo for the text
  landing. A scenario submits only on a terminal from `start`, or after `prompted`
  where it reaches the prompt another way, such as past a trust question or a resume;
  `turn` submits a prompt, waits for its reply on screen
  and for the turn to run and end; `replies` and `sends` are rules that answer a prompt
  with text or with a `send`; `own` keeps a rule off side calls; `deliveries(call)`
  parses the `<novadeck-messages>` a hook added, plain or HTML-escaped, into
  `{ from, text }`; `ring` matches the doorbell's line; `opens` is a rule that answers a
  prompt by starting an agent with a task (`open_terminal`), and `opened(call, handle)`
  tells the agent's next look once it did; `closes` and `closed(call, handle)` do the
  same for closing a terminal (`close_terminal`); `answers(text, reply)` answers a
  prompt with a reply built from the call, such as a trait's, and `result(call)` is the text of the
  tool result the call looks at, if it looks at one. `unrung` is how long a scenario
  watches a terminal for a ring that mustn't come, past the doorbell's settle window;
  `handing(run, first, then)` opens a terminal whose command runs `first`, then `then`
  once it exits (`claude ; codex`), and waits until the first is at its prompt.
- **Novadeck's state** is recorded as it changes, not polled: each deck terminal keeps
  the history of its delivery state and its messages' states from the moment it opens.
  `t.mark()` and `t.reached(state or predicate, { after })` wait for a transition after
  a point, and `through(t, steps, { after })` for several in order, such as
  `["ringing", "working"]` or `holds("t1", "t2", "delivered")`. Each step is met at or
  after the one before it, in the same snapshot or a later one, as changes the runner
  makes in one go arrive together. On a timeout they fail with every transition since
  the mark (`t2: ready → ringing → unknown`), and `through` also says which steps were
  met (`met: ringing; waiting for: working`), so a failure says what happened. Their
  failures, and those of `until`, `confirm` and `t.poll(read, what)`, end with what its
  agent is doing (`working, 1 request waiting (permission)`) and the terminal's screen
  as it is then, its non-blank rows and at most the last 30 (`withScreen` in `deck.ts`),
  so a wait that times out also shows what the terminal was doing instead, and then
  the fake model's last five calls, one line each (`model.trail()`): what each carried
  last, such as a tool's result beside the call it answers, cut short. A scenario
  waits on something of a terminal through `t.poll`, never the bare `poll`. A test that
  throws fails its own wait, with its error, and no other.
- **A wait for a model call explains itself from the terminal side too.** The fixture
  gives the fake model `deck.report()` (`model.explain`), so `model.waitFor` failing with
  "No matching model call" also lists `model.trail(8)` and then "The terminals:", each
  terminal's agent state and the last 12 rows of its screen, each in its own share of 3000
  characters (a screen over its share keeps its last rows behind "… (cut)"): a dialog
  still open there, an Enter that went nowhere, show at once. The describer has five
  seconds to answer, and the whole account is cut at 6000 characters.
- **Refused calls fail the scenario at once.** A result a dialect words as its harness
  refusing the model's call itself (`Dialect.rejection`), as opposed to a tool that ran
  and failed, is recorded in `model.rejections` when the call carrying it arrives. The
  deck's waits (`until`, `reached`, `through`, `poll`, `confirm`, `submit`) and
  `model.waitFor` then fail within a tenth of a second, naming the call and the harness's
  answer, instead of timing out downstream. The test also fails at its end with the
  refusal, even when a wait already failed with it, so a test that catches that wait's
  error can't hide it. A probe that provokes one on purpose says so with
  `model.expectRejection(match)`, which keeps matching refusals out of `rejections`
  (in `model.expected`). A rule that answers with a tool call must skip side calls, as
  `own` does: they offer no tools, so the harness refuses the call. The wordings seen,
  probed in the sandbox: Claude Code's
  `<tool_use_error>` for an unknown tool (`Error: No such tool available`) or arguments
  it won't take (`InputValidationError`), Codex's `unsupported call: <tool>` and `failed
to parse function arguments`, and Antigravity's `Encountered error in tool validation`,
  for both. Not refusals, so the scenarios that provoke them keep working: a tool's own
  errors (Novadeck's "has no agent Novadeck can deliver to", Antigravity's `Encountered
error in tool execution`, Claude Code's other `<tool_use_error>`s such as a missing
  file) and the person denying a tool, whose result never reaches the model. A new
  harness's `rejection` comes from probing it, never from a guess.
- **Holding a turn** pins down how something travels. The round trip holds t2's answer
  at a `gate()` until t1's turn has ended Settled, and asserts t1 is then rung, rather
  than reached by its Stop continuation.
- **What Novadeck knows of an agent**, as a client's detail view reads it, is
  `await t.detail()`: the session bound, its activity, and the requests it waits on the
  person for. The boot scenario reads there that nothing waits on the person and whether
  a session bound at Ready; Ready itself says the agent's own prompt shows, past its
  startup screens.
- **Restarting the runner.** `deck.restart()` closes the runner as Novadeck does when it
  quits, saving every terminal and ending its shells, and wires another, as Novadeck
  starts again, on the same database, shell folder and sandbox, with the same fake
  model. Between the two, `reap.ts` looks for processes the first runner left in the
  sandbox, and any it finds fails the restart as a leak. The first runner's deck
  terminals are gone with it, their histories ended; the new runner lists their records
  as saved (`started: false`) until `deck.restore(t, { resume: agent })` starts one
  again, as the app does for each terminal it shows: `terminals.create` with its id and
  `restore`, and `resume` naming the agent that ran there, which the runner resumes in
  the session that agent last reported in it. `deck.terminals` and `deck.store` are
  always the current runner's. A restart can catch a lease its hook holds: started from
  the history step that shows the message `leased`, it stops the runner, ending every
  lease, in the same tick the runner leased it, as message watches coalesce a tick's
  changes with `setImmediate`, while the hook has yet to read its answer, print it and
  connect again to acknowledge it. The restart scenario does so: the new runner's first
  listing of the terminal, restored, holds the message queued, and the resumed session
  is rung for it again.
- **Novadeck's shell files.** `deck.shell` is where Novadeck's shells read their files,
  the same across restarts. A scenario reads it only as a readiness signal for the
  person's _while it starts_ scenario, a peek at the shell's resume files
  (`deck.shell.resume` empty once the shell has taken the command starting the agent),
  never to drive or assert Novadeck's state.
- **Agents' requests for a terminal.** Without a client answering them, an agent's
  `open_terminal` opens nothing. `deck.answerRequests()` answers them as the app does,
  from the call on and across restarts: it opens a terminal in the request's folder,
  starting its command, created for the request (`requestId`), and answers with it once
  its shell has started. `next()` on what it returns waits for the next terminal it
  opened, in order, as a deck terminal.
- **The controls' scenarios** (`controls.e2e.ts`), one smoke test per framework piece,
  asserting what docs/agent-messaging.md says ("What counts", "States"):
  - _Approval allowed_: the tool's question shows and Novadeck sees a request waiting;
    `confirm` allows it; the model reads the tool's result, the turn goes Working then
    Settled, never Unknown, and no request waits.
  - _Approval denied_: pressing `deny` refuses it; the turn ends Unknown, never Settled,
    and the request resolves; the screen shows `denied`, and no call bearing a tool's
    result reaches the model in the three seconds after.
  - _Escape_: with the first model call held at a `gate()`, `escape()` interrupts the
    turn; it ends Unknown, the screen shows `interrupted(prompt)`, and once the held
    reply is given, three seconds pass without it showing or the turn going Settled;
    the next prompt's turn settles. Delivery goes Unknown as Novadeck sees the key, so
    only the harness's own account shows that it interrupted.
  - _Empty Enter_: with the turn's model call held, `enterEmpty()` presses Enter on the
    empty box; the turn works on and ends Settled, no other turn starts, and a message
    t2 then sends rings t1.
  - _Background_: the agent starts background work and its turn ends while it runs (its
    activity idle); delivery stays Working, never Settled, until the work ends and wakes
    the agent, then Settles.
  - _Hooks untrusted_: past its hooks review, unskipped, one `send` from t1 to t2 is
    refused (no agent there, or the hooks named), its answer says replies can't reach
    t1, no message is stored, and neither terminal ever binds or shows an agent.
  - _Folder untrusted_: t1 and t2 both ask; trusted in t1, t1 sends t2 a message, which
    waits queued while t2's question shows, past the doorbell's settle window, t2 never
    Ready nor rung; trusted there too, t2 goes Ready, is rung, and its hook delivers.
- **The chat's scenarios** (`chat.e2e.ts`), `agents.prompt` and `agents.interrupt` as the
  chat view calls them (`t.prompt(text)`, `t.interrupt()`), read back as a client does
  (`t.transcript()`: the root actor's items, by the ref `agents.detail` names):
  - _One line_ and _several lines_: the transcript holds the user item with that text,
    each line whole, one user turn, and the fake model's reply; the turn goes working,
    then settled. A _long_ prompt (40 lines), which a TUI may show as a placeholder, too.
  - _Named alike_: a terminal given its first prompt this way is named as one typed in
    another terminal is, whatever that is for the harness.
  - _Mid-turn_: with the reply held, a second prompt (several lines) queues, or steers,
    as the person's would: both prompts and both replies reach the transcript.
  - _Interrupt_: with the reply held, `interrupt()` ends the turn without a normal Stop
    (Unknown), the harness says it was interrupted before the held reply is let go,
    which never shows; the next prompt's turn settles.
- **The Escape race** (`escape-race.e2e.ts`), a raw Escape pressed as a held reply is
  let go, a few ms ahead of it where that loses the key (per harness; probed): retried
  until the reply wins, the turn reads `completed` with that reply as `lastTurn` once the
  harness has had its say (the runner's 1.5 s window, waited out); every attempt, won or
  lost, reads as the screen shows it ended (interrupted where the Escape stands), and an
  Escape that ended the turn first never reads completed before the harness's
  interruption. The activity's transitions are unit-tested; which side wins is the
  harness's.
- **The answers' scenarios** (`answers.e2e.ts`), `agents.answer` as the chat's request
  cards call it, through each harness's dialog adapter: a permission allowed, refused, and
  refused with the person's words (sent as the next prompt where the dialog takes none);
  a question by option, several picked, and in the person's own words; a plan approved,
  and rejected with feedback; the person's keys elsewhere held while an answer runs; and
  the fallback, a dialog its adapter can't read (a stub) or a harness without one, shown
  raw with nothing pressed. A harness without a kind of question (Codex asks no
  multi-select) skips that scenario, saying so.
- **The person's scenarios** (`person.e2e.ts`), the person typing around messages,
  asserting docs/agent-messaging.md's "Acceptance scenarios" for them. In each, t2 sends
  t1 a message from its own prompt, which waits queued; a terminal that mustn't be rung
  is watched past the doorbell's settle window; and no model call ever holds the
  doorbell's line:
  - _Mid-sentence_: after a turn, Settled, the person types half a prompt (`press`); t1
    goes Drafting, and the message waits, never rung. `submit` finishes the sentence: the
    model's call holds the whole prompt with the message beside it, the one call that
    carries it, and the turn settles.
  - _Queued prompt_: with the turn's reply held at a `gate()`, the message comes, then
    the person submits their next prompt. The model's call holding that prompt carries
    the message, and no other call does, so no Stop continued the turn with it. Each
    harness gets there its own way, which the scenario doesn't ask: Claude Code and
    Antigravity run the queued prompt after the Stop (Drafting in between), and Codex's
    Enter steers it into the running turn, its hook firing as it is submitted.
  - _Next prompt typed mid-turn_: with the reply held, the person types without
    submitting, and a message comes. Having submitted nothing, the Stop continues the
    turn with it (its call holds no typed text), and the turn ends Drafting, never
    Settled. A second message then waits, never rung, and the person's prompt carries it.
  - _Ready_: the person types at the agent's first prompt; Drafting, never rung; their
    prompt carries the message.
  - _While it starts_: the person types once the shell has taken the command starting
    the agent (its file in `deck.shell.resume` gone), and Novadeck, taking the keys in
    the write itself, still sees it Unbound. Whether the harness had drawn its first
    screen by then is a race a fast harness wins, so the scenario doesn't ask. Its first
    state past Unbound is Drafting, never Ready nor rung, whatever of the keys reached
    its box; the person's prompt carries the message.
- **The requests' scenarios** (`requests.e2e.ts`), a message that comes while the agent
  waits on the person, asserting docs/agent-messaging.md's "Acceptance scenarios" for
  them. t2 sends t1 the message from its own prompt:
  - _Permission question open_: t1's tool waits on its `approval` question when the
    message comes; it waits queued past the doorbell's settle window, t1 never rung, its
    turn Working. `confirm` allows the tool, and the Stop after it delivers: the model's
    call carrying the message comes after t1's look at the tool's result (a call of the
    conversation holding t1's prompt, not t2's look at its send), in the same
    conversation, after its answer to it and with no prompt of anyone's, and t1 is only
    ever Working until it settles.
  - _Enter on a permission question_: with the turn's first model call held until the
    message waits, `confirm` answers the question that call brings. The Enter is no
    submission: the Stop continues the turn with the message, as above, and t1 is never
    Drafting from its turn on.
  - _Esc-Esc_ (`rewind`): after a turn, with its screen calm, the person opens what
    Esc-Esc opens, and the message comes. Where it swallows the paste, the ring fails:
    t1 goes Ringing then Unknown, it stays open with no doorbell line in it, the message
    waits queued and no model call holds the line; once the person leaves it with
    Escape, their next prompt's hook delivers. Where the paste leaves it, the ring goes
    on as at an empty prompt: the doorbell's line is the prompt, and the call still holds
    the turn before it, so nothing was rewound.
  - _Popup after the Stop_ (`popup`, seeded `popup: true`): the turn's reply makes the
    harness raise its popup, which shows before the message comes. The ring's test paste
    fails on it: Ringing then Unknown, the popup still up, the message queued and no
    model call holding the line. The person leaves it with Escape and submits a prompt,
    whose hook delivers, to the model the turn before used, as no option was taken.
- **The lifecycle's scenarios** (`lifecycle.e2e.ts`), the person clearing the
  conversation or leaving the agent, asserting docs/agent-messaging.md's "Acceptance
  scenarios", "Messages" and "Message states" for them. Each starts with a turn, so a
  session is bound:
  - _`/clear`, then a message_: the clear drops the conversation from the screen, and
    Novadeck sees the agent Ready with the old session no longer bound (a new one, or
    none yet where the harness binds only at its next prompt). t2's message rings it; the
    new session's hook delivers it, the call holding nothing of the conversation before
    the clear, and the session bound then is neither none nor the old one.
  - _A message waiting at `/clear`_: the person types `/clear` (Drafting), and t2's
    message comes for the session, queued; once the clear is submitted the message is
    `gone`. t2's next `send` answers that it won't arrive, and the new session is rung
    for that second message alone.
  - _Another agent in the terminal_: the terminal opens with `claude ; claude` (its
    harness twice), so the person leaving the first starts the second with no key
    pressed at the shell's prompt; Novadeck expects the first, by the command's first
    word. With `/exit` typed and submitted as above, the message is `gone` and the second
    start is Ready, another session, and draws its `banner` anew: once more than the
    fewest times the screen showed it since the Enter, as Claude Code and Codex clear
    their screen as they exit and Antigravity leaves its own, so the first's banner
    can't pass for the second's. No Unbound need show between them: with no shell
    prompt in between, Novadeck notices the first process gone only as the next reports,
    in the same handling as the session it binds. t2's next `send` says the first won't
    arrive, and the new session gets only the second. `lifecycle.mixed.e2e.ts` does the
    same with a different harness second, each harness's terminal starting the next's.
- **The nested run's scenario** (`nested.e2e.ts`, `shell`): t1's turn runs the harness
  itself once through its shell tool, started only once t2's message waits for t1. The
  nested run's model call comes, carrying nothing, and its answer reaches t1's agent as
  the tool's output. Then t1's own Stop delivers the message in t1's conversation: never
  a ring (its call holds no doorbell line, and t1 is never Ringing) and nothing Settled
  before it. No call of the nested run carries a message; while it ran, t1 stayed
  Working and the message queued, never leased; t1's session and agent are as before.
  The shell tool waits for the command up to its harness's ceiling (Antigravity 10 s,
  Codex 30 s, Claude Code 2 minutes), far past the second a nested run takes.
- **The forks' scenarios** (`forks.e2e.ts`), asserting docs/agent-messaging.md's
  "Acceptance scenarios" for forks:
  - _A fork from a picker_ (`fork.picker`): t1 takes a turn and t2 another; a third
    terminal starts the picker, its latest session (t2's) selected. t2's message for t3
    waits queued while it shows, t3 only ever Unbound and never rung past the settle
    window. Once the person picks t1's session, the fork goes Ready, is rung, and its
    hook delivers the message alone, in a call holding t1's conversation; the fork's
    session is neither none nor t1's, and t1's is unchanged. A message for t1 then rings
    t1, its hook delivering it in t1's own conversation, which holds nothing of the
    fork's; both sessions stay as they were, and t3 has only its own message.
  - _A fork in place_ (`fork.inPlace`): with the person's draft in t1's box, t2's message
    waits; they erase it and submit the fork command. The message is `gone`, never
    delivered, and the fork is Ready; t2's next message rings it, its hook delivering
    that one alone in the conversation carried over, and the session bound is no longer
    the parent's. Claude Code's `/fork` doesn't fork in place (its `absent` says why).
- **Codex's own** (`codex.e2e.ts`), behaviour only Codex has:
  - _First screen_: its logo shows as t2 is rung, and the ring goes through (the
    doorbell's paste erases it).
  - _`/side`_: with a side conversation open, t2's message waits, t1 Drafting from the
    person's keys, never Ringing nor Unbound, and no call holds the doorbell's line past
    the settle window. The side conversation's first prompt carries nothing; t1's
    session and agent stay, the message queued. Back at the root (Ctrl-C closes the side
    view), the person's next prompt carries the message, in the root's own conversation,
    which never held the side question, and t1 settles, still bound to the root.
  - _A spawned agent's dialog dismissed with Esc_: t1's root spawns an agent
    (`spawn_agent`, `multi_agent_v1`) and its turn ends; the agent's escalated
    `exec_command` asks (its `approval` request), the dialog showing in the root's screen
    as "Thread: Agent (<id>)". Novadeck sees the request waiting (`detail().requests`,
    `activity.attention`) from a subagent it lists as running. t2's message waits queued
    past the settle window, t1 never rung and no call holding the doorbell's line. The
    person presses Esc on the dialog (`escape()`, never Enter), which fires no hook:
    Novadeck's request goes to none by following the agent's own rollout, the subagent
    still listed as running, and t1 is then rung and its hook delivers. Codex's own
    evidence that it aborted: the dialog's thread line leaves the screen, the agent's
    rollout (`rollout-<time>-<agent id>.jsonl` under `CODEX_HOME/sessions`) holds
    `turn_aborted`, and no call of its conversation ever looks at the command's result.
    It pins the undocumented rollout naming and record Novadeck relies on there.
- Prefer asserting on what the model received and on Novadeck's state over reading the
  screen; read the screen for what only it shows, such as a reply rendered, or the
  harness's own first screen (`banner`).

## Probe fixtures

The probes under `src/e2e/probes/` record what a real harness showed, and the adapters'
tests replay it from `harnesses/<agent>/fixtures/*.probe.json` and
`terminals/fixtures/doorbell-<agent>.json`. Every screen in them has one shape, a
`ScreenRecord` (`src/testing/probes.ts`), the one the input-box probe first used:

```json
{
  "height": 40,
  "columns": 120,
  "cursor": { "row": 36, "column": 2 },
  "rows": { "1": "  >_ OpenAI Codex (v0.159.3)", "36": "› Ask Codex to do anything" },
  "bright": { "36": "›" }
}
```

- `rows` is sparse: only rows that show anything, by row number, as `screenText` reads
  them. `height` is how many rows the record holds, the screen's own or, for a probe that
  only had the screen's text, those up to the last that shows anything.
- `bright` holds only the rows whose dim cells blank some of their text (a placeholder
  suggestion), as they read undimmed; every other row reads as `rows` does.
- `columns`, `cursor` and `bracketedPaste` are optional, kept where the probe knew them.
  Read back, they default as `testing/screens.ts` does: 80 columns, the cursor on the last
  row that shows anything, bracketed paste on. `styles` is a probe's note on each row's
  style runs, for a reader's eyes; no test reads it.
- A screen sits wherever its fixture needs it (`screens.wide`, `steps[].screen`, a doorbell
  pair's `before` and `after`), beside whatever else the probe saw (hooks, status lines,
  what the model received). That stays as the probe wrote it.

**Reading:** `loadProbe<T>(folder, name)` reads `<folder>/fixtures/<name>` and gives every
`ScreenRecord` in it back as the `ScreenText` it recorded; `T` is the test's own account
of the rest. Every test that reads a probe fixture goes through it, screens or not.
**Writing:** a probe makes a record with `screenRecord(screenText(terminal))`, or
`screenRecord(text, { columns })` where it only has the screen's text, and puts it in what
it writes. A fixture is that output copied in, scrubbed of the sandbox's paths.

Not screens, so not in this shape: the hook payloads, status lines, transcripts, rollouts
and `exec` events (`hooks`, `statusline`, `transcript`, `rollout`, `plan`, `exec`,
`shell`, `interactive`, `modes` probes) are the harness's own records, whose shape is the
harness's. Those probes' fixtures are read with `loadProbe` too, but hold no screen to
convert. The model fixtures under `src/e2e/model/fixtures` are recorded HTTP requests, not
probe output, and keep their own loader.

## Adding a harness

1. Pin it in `harnesses.json` (an npm package, or an archive with its SHA-512) and make
   sure `installHarness` can install it. Its name must be one of the protocol's
   `agentName`s.
2. Write its API's dialect in `src/e2e/model/`, unless it speaks one already there: it
   parses requests into `Call`s and encodes `Reply`s the way the harness reads them. It
   also answers the side endpoints the harness calls on the way to its prompt. To find
   those, run the harness against the fake model and read `model.strays`, which lists
   both requests no dialect took and those a dialect answered 404.
3. Write its `AgentSetup` in `src/e2e/agents/`:
   - `prepare(sandbox, model, installed, seed)` seeds its configuration in the sandbox so
     it starts at its own prompt with no screen in between, for the version actually
     installed, and returns the environment that points it at the fake model with the
     fake credential. `connected(sandbox, model, seed)`, when given, runs once Novadeck's
     plugin is connected and before any harness starts, for setup only the plugin's files
     make possible. Both honour the test's `Seed` (`folderTrusted: false`,
     `hooksTrusted: false`, `popup: true`) for each step the harness has, and ignore the
     rest.
   - Its traits: `name`; `banner`, text on its first screen; `bindsAtReady`, whether
     its session binds before its first prompt; `hosts`, its real API and login hosts,
     which no request may try; and `refused`, hosts it tries that no setting turns off.
   - `watch`: the paths in the developer's home its tripwire checks, searched for the
     sandbox's root, listed by entry name, or stamped by time and size.
   - The controls' traits (see [Writing a scenario](#writing-a-scenario)): `approval`, a
     tool call it asks about as seeded, its question and the keys that refuse it;
     `background`, work that outlives the turn and wakes the agent, and how to tell its
     model calls; and `trust`, its folder-trust question and hooks review as a seed
     shows them. Find each by running the harness in the sandbox, never outside it. A
     scenario needing a trait it lacks skips, saying why from `absent`, so add them all:
     every harness runs every scenario. A trait goes in `absent` only once a probe shows
     the harness lacks the behaviour. Escape is `\x1b` for all three; a harness reading
     another key would bring back an `escape` trait. Likewise all three clear their
     conversation with `/clear` and leave with `/exit`, each typed at their prompt and
     submitted (probed 2026-10-02); a harness with another command would bring back a
     `clear` or `exit` trait.
   - `shell`, a reply running a command through its shell tool, and its own one-shot,
     non-interactive mode as the command, which its seed allows so it runs without
     asking, unlike `approval`'s, and which waits for the command as long as the tool
     allows (its ceiling, found by a probe, as Antigravity's `run_command` caps its wait at
     10 s). A harness with no non-interactive mode has it `absent`.
   - `fork`, how the person forks a session: `picker`, a command forking the session
     picked in its picker, and `inPlace`, a command forking the conversation in place.
   - The requests' traits: `rewind`, what Esc-Esc opens at its idle prompt and whether
     it swallows a paste; and `popup`, a popup it raises by itself after its Stop, which
     a reply's `usage` or `limits` (and the `popup` seed) can bring about.
4. Add the setup to `setups` in `src/e2e/agents/index.ts`. That one list drives the
   messaging scenarios and the tripwire, so every scenario runs for it and its home is
   watched. A gap it shows goes in `known-gaps.ts`, with the test that pins it.
5. Add it to the CI matrix in `.github/workflows/e2e.yml`, with its display name.

## Claude Code against the fake model

- **Seeding.** Its config folder is `<sandbox home>/.claude`, set as `CLAUDE_CONFIG_DIR`.
  Its `.claude.json` there marks onboarding done, picks a theme, records the installed
  version's onboarding and release notes as seen (the version installed, not the pin, so
  a run against `latest` shows no release notes), turns auto-updates off, approves the fake key (by its last 20
  characters), and trusts the project unless seeded `folderTrusted: false`. Seeded
  `popup: true`, it also names an account (`oauthAccount`) with a billing admin's roles,
  for whom Claude Code warns of a session's cost.
  `settings.json` allows Novadeck's MCP tools (`mcp__plugin_novadeck_novadeck`) and its
  own print mode (`Bash(claude -p:*)`, for `shell`), and sets the manual permission mode with auto mode off (`defaultMode: "default"`,
  `disableAutoMode: "disable"`): 2.1.287 defaults to auto mode, where a classifier
  decides what asks, and shows a notice about its billing through a gateway, or with
  `defaultMode` alone an offer to make auto mode the default, each waiting on Enter.
- **Its controls' traits**, probed in the sandbox against 2.1.287:
  - _Approval_: Bash `touch approved.txt`. A read-only command such as `ls` runs without
    asking. Its dialog, "Do you want to proceed?", shows `❯ 1. Yes` selected, then
    "2. Yes, and always allow…" and "3. No", with "Esc to cancel". "3" refuses (`deny`),
    and so does Esc; either interrupts the turn ("Interrupted · What should Claude do
    instead?", `denied`), which Novadeck sees through its transcript, so the turn ends
    Unknown.
  - _Background_: its `Agent` tool with `run_in_background: true` and a
    `general-purpose` subagent whose prompt holds a marker; the subagent's calls are
    those whose first user turn holds it. The root's Stop lists it among its running
    `background_tasks`, and its end starts a turn by itself, with a task notification.
  - _Escape_: `\x1b`. Its Esc-Esc window is about 800 ms (see "Escape on its own" above).
    Escape before any reply came drops the turn with no word of it and puts the prompt
    back in its box, between the box's rules (`interrupted`).
  - _Folder trust_: "Is this a project you created or one you trust?" with `❯ No, exit`
    selected; Down selects `❯ Yes, I trust this folder`. About 130 ms after it first
    shows, it draws the question again with `❯ No, exit` selected anew, undoing a Down
    pressed in between, so the scenario presses Enter only once the trusting option has
    stayed selected for a second. No `SessionStart` fires behind it. Once trusted, it
    reports its `SessionStart` a moment before its prompt draws, while the terminal
    still echoes what's typed, which `prompted` waits past. It has no hooks review.
  - _Rewind_: Esc-Esc at its idle prompt opens its Rewind picker ("Restore the code
    and/or conversation to the point before…"), a list with no text field, which
    swallows a paste and stays as it was.
  - _Popup_: a reply reporting 300k output tokens (`usage`) puts the session's cost over
    $5 (on Opus 5.5), and once the turn has ended it raises "You've spent $5 on the
    Anthropic API this session." with `❯ 1. Got it, thanks!` selected. It shows only for
    a billing admin (`popup: true`); its context meter counts input tokens alone, so
    nothing compacts.
  - _Shell_: its Bash tool running `claude -p '<prompt>'`, which prints the nested
    session's answer. The nested Claude Code reports its own `CLAUDE_PID` and session
    to Novadeck's hooks, a `SessionStart` (`startup`), its prompt and its Stop.
  - _Fork_: `claude --resume --fork-session` shows its "Resume session" picker, latest
    first, each session by its first prompt, the first selected (`❯`), with no
    `SessionStart` until one is picked; picked, the fork starts at its prompt with a
    session of its own. Its `/fork` copies the conversation into a background session
    and keeps working in the terminal's own, whose binding stays, so it has no
    `fork.inPlace`.
- **Environment.** `ANTHROPIC_BASE_URL` points at the fake model and
  `ANTHROPIC_API_KEY` holds the fake credential. Also set: `DISABLE_AUTOUPDATER`,
  `DISABLE_UPDATES`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` and
  `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`.
- **What it calls.** 2.1.287 makes no request at all on the way to its prompt, and
  nothing goes through the proxy. Each prompt makes one side call to
  `POST /v1/messages?beta=true` with no tools (the session's title), and the agent's
  calls go to the same endpoint, streamed. A `UserPromptSubmit` hook's
  `additionalContext` arrives as a `system` message just after the user's message, and
  the dialect folds it into that user turn.

## Codex against the fake model

- **Seeding.** `CODEX_HOME` is `<sandbox home>/.codex`. Its `config.toml` defines a
  model provider of its own (`wire_api = "responses"`, `base_url` at the fake model,
  the fake credential in `NOVADECK_E2E_CODEX_KEY`), points `chatgpt_base_url` at the
  fake model, switches off update checks, analytics and metrics, and trusts the
  project. An empty copy of OpenAI's curated plugins keeps Codex from downloading them
  from chatgpt.com. A rule of its execution policy (`rules/default.rules`,
  `prefix_rule(pattern = ["codex", "exec"], decision = "allow")`) lets `codex exec` run
  unasked, for `shell`; so allowed, the nested Codex reached the fake model and wrote its
  rollout in its home.
- **Its startup screens.** Seeded `folderTrusted: false`, the project is made a Git
  repository: Codex 0.160.1 and later ask "Trust this folder?" only in one, where
  0.159.3 asked of any folder. Codex draws that question and "Hooks need review" before
  it reads keys, and drops a key pressed then, so the folder question's selection is
  moved away and back (Down, Up) before Enter, and the review's Esc is pressed again
  while it still shows.
- **Hook trust.** Codex runs a plugin's hooks only once trusted, and Novadeck counts
  its prompt only then. Once the plugin is connected, `connected` starts the pinned
  `codex app-server` and makes the calls its "Hooks need review" screen makes:
  `hooks/list` for each hook's current hash, then `config/batchWrite` to record them
  as trusted, and to let Novadeck's MCP tools run without asking. It copies the hashes
  rather than computing them, so it holds as long as that protocol does, which Novadeck's
  own trust check relies on too.
- **What it calls.** 0.159.3 sends its model calls to `POST /v1/responses`, and asks
  `GET /backend-api/plugins/featured`, which the dialect answers with none. MCP tools
  are offered in a `namespace` (`mcp__novadeck`), and the dialect names them
  `mcp__novadeck.send`. A prompt hook's context arrives as a developer message after
  the prompt; a Stop hook's reason as a user message `<hook_prompt>`, HTML-escaped. A
  call is `side` when its `x-codex-turn-metadata` says it isn't the agent's turn, as
  its thread's title. It reads its rate limits from the response's headers (`limits`).
- **Its traits**, probed in the sandbox against 0.159.3, beside the controls' (see its
  setup):
  - _Rewind_: Esc-Esc at its idle prompt browses its transcript, its footer saying so
    ("Browsing transcript · … ↵ rewind · esc back"). A paste leaves that mode and lands
    in its composer, rewinding nothing.
  - _Popup_: a reply reporting 95% of both rate-limit windows used (`limits`) warns of
    them in the transcript, and once the turn completes raises "Approaching rate limits",
    offering a cheaper model with `› 1. Switch to …` selected; Enter would switch.
  - _Shell_: `exec_command` running `codex exec --skip-git-repo-check '<prompt>'`; the
    project isn't a Git repository, and without the flag `codex exec` refuses to run
    there whatever its trust. The nested Codex's hooks run with the agent's thread in
    `CODEX_THREAD_ID`, so its decoder takes nothing of them.
  - _`/side`_: typed and submitted, it shows a side conversation, its footer saying "Side
    from main thread · ctrl+/ to switch · ctrl+c to close" (0.161.0 spells the keys `^/`
    and `^c`); ctrl+c goes back to the root.
    Its thread is ephemeral: its first prompt fires a `SessionStart` saying `fork`, and
    every hook of it gives `transcript_path` as null.
  - _Fork_: `codex fork` shows its "Fork a previous session" picker, latest first, each
    session by its first prompt, the first selected (`›`), with no title until one is
    picked ("enter fork"); picked, the fork shows "Thread forked from <id>", its title
    Ready with the fork's id, and its session binds at its first prompt; given an id,
    `codex fork <id>` skips the picker. `/fork` at its prompt says "Fork created. You can continue
    here.": its title names the fork, whose new writer lock confirms it as the new root,
    so the parent's binding ends and the terminal is Ready, its messages gone.
- **Refused tunnels.** Codex's curated-plugin sync and its startup tips try GitHub
  (`github.com`, `api.github.com`, `raw.githubusercontent.com`), which no setting turns
  off. The proxy refuses them; they are its setup's `refused`, and the hermetic
  scenario checks that they are the only tunnels tried.

## Antigravity against the fake model

- **The Gemini API, not Code Assist.** Signed in, Antigravity talks to Code Assist, which
  takes its models from the account's plan; under fake credentials it never loads any.
  The suite uses the route Antigravity documents for running without signing in:
  `modelProvider: "gemini"` in its settings, with `GEMINI_API_KEY` holding the fake
  credential and `GOOGLE_GEMINI_BASE_URL` pointing at the fake model. The Code Assist
  route stays untested.
- **Seeding.** `~/.gemini/antigravity-cli/settings.json` in the sandbox marks
  onboarding complete, trusts the project, picks the Gemini provider and allows
  Novadeck's MCP tools (`mcp(novadeck_novadeck/*)`) and its own print mode
  (`command(agy -p)`, for `shell`) to run without asking. Its shell tool, `run_command`,
  runs `agy -p '<prompt>'`, waiting up to 30 s before leaving it to run on; the nested
  Antigravity's hooks report a conversation of its own. `/fork` at its prompt says
  "Forked conversation." and how to go back (`/resume <parent>`); its status line names
  the fork, which binds, Ready, the parent's messages gone, and back again should the
  person resume the parent. No command line forks a conversation, so it has no
  `fork.picker`.
  `AGY_CLI_DISABLE_AUTO_UPDATE` stops it updating itself.
- **What it calls.** 1.2.14 streams each model call from
  `POST /v1beta/models/<model>:streamGenerateContent?alt=sse`; its session's title is a
  call with no tools, so `side`. MCP tools are lazy: it offers one `call_mcp_tool` and
  lists Novadeck's tools in its system prompt, so the dialect offers them by the names
  Antigravity gives tools it loads (`mcp_novadeck_novadeck_send`), and encodes a call to
  one as `call_mcp_tool`. Now and then it loads them eagerly instead (seen 2026-10-08
  twice in about 150 runs of a test opening terminals in a folder it didn't trust yet;
  what makes it do so is unknown): its system prompt lists them under `Eager:`, it
  declares each as a tool of its own and offers no `call_mcp_tool`. A call to one then
  needs a `toolSummary` beside its arguments and no `toolAction`, which Antigravity
  refuses as invalid arguments otherwise; the dialect reads either listing and gives
  each call what it needs. A server's `tools` entry with `{ "eager": true }` for each of
  its tools in its `mcp_config.json` loaded them eagerly in every run that had it, which
  reproduces it. A `PreInvocation` hook's message arrives as a user content just after
  the prompt.
- **Refused tunnels.** Its feature flags (`antigravity-unleash.goog`) and telemetry
  (`play.googleapis.com`) go through the proxy, which refuses them; they are its setup's
  `refused`.
- **The keyring.** Signed in on the machine, Antigravity reads its login from the secret
  service whatever HOME says. The sandbox's dead D-Bus address is what keeps it out.
- **Traits it lacks**, probed in the sandbox against 1.2.14: `rewind`, as Esc-Esc opens
  nothing (its rewind is the typed `/rewind` command, which Untouched covers); and
  `popup`, as nothing shows after a turn on its Gemini API route, its screen still for
  15 s, and its program holds no dialog for after one: its quota screens belong to the
  Code Assist route, which the suite doesn't run.

## Known gaps

None stands today. A known gap is a difference between harnesses the suite works around
until Novadeck closes it, and is raised with the person first (see AGENTS.md, "Harness
Parity"): never a reason to leave a harness out.

`known-gaps.ts` names each one as a `Gap`, with the harnesses it affects, documented
with its cause, the test that pins it and what to assert once it is fixed. The scenarios
never ask which harness they run: they ask a function built on `has`, named for the
behaviour that differs, which picks the detour. Each gap is also pinned by a test that
asserts today's wrong behaviour, so it can't pass unnoticed: once fixed, that test fails
and says what to assert instead. Fixing a gap means deleting its entry, its function and
the detour, and turning its pin into the real assertion; list it here meanwhile.
