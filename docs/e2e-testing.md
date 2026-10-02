# End-to-end tests

The end-to-end suite runs the real Claude Code, Codex and Antigravity TUIs in
NovaDeck's terminals, with NovaDeck's real plugin, hooks and MCP server, against a
scripted fake model. It checks agent messaging the way people use it, with real
harnesses: an agent calls `send`, NovaDeck rings the idle recipient, and the reply comes
back. The model is the one part replaced, so runs need no credentials, cost nothing and
give the same result every time.

## Running

The suite runs on Linux only. Its keyring cut is a dead D-Bus address, which doesn't
keep a harness from the macOS Keychain, and its leftover-process check reads `/proc`.
On anything else the fixture fails each test, saying so; a scenario file can skip
instead with `describe.skipIf(!supported)`, `supported` coming from `fixture.ts`.

```sh
npm run test:e2e                  # from the repository root; builds the protocol first
pnpm --filter @novadeck/protocol build
pnpm --filter @novadeck/runner test:e2e
NOVADECK_E2E_AGENTS=claude pnpm --filter @novadeck/runner test:e2e   # one harness
```

The runner's own script doesn't build `@novadeck/protocol`, so build it first when
running the suite from `application/runner`, as the root script does.

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
the whole suite with `NOVADECK_E2E_AGENTS` set to that harness. Its pinned installs are
restored from a cache keyed by that harness's own entry in `harnesses.json` and by
`install.ts`, so moving one pin leaves the others' caches alone: the
entries of `<cache>` without npm's own cache (`<cache>/home`) or unfinished staging
(`*.tmp`). Unless the run was cancelled, they are saved even when the tests fail, so the
next run needn't install again, but only once a `<cache>/<harness>-*` folder holding the
harness's program exists: a failed or cancelled install saves nothing under the key.

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
  no harness finds a login in the secret service.
- **No network, as far as harnesses honour the proxy.** The fake model is also every
  process's `HTTP(S)_PROXY`, with `NODE_USE_ENV_PROXY=1` so Node's own `fetch` takes it
  too. It refuses each tunnel and each request for another server and records its host,
  never its path. Only loopback is exempt. This blocks egress only for programs that
  honour the proxy: one that connects directly isn't stopped, and is caught only if it
  reaches a host whose failure shows. Running CI in an OS-level network namespace with no
  route out is a known follow-up.
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
    (NovaDeck's copy among Codex's installed plugins; not the folder itself, where the
    developer's own Codex refreshes its bundled plugins whenever it likes),
    `~/.gemini/config/plugins` (where NovaDeck installs Antigravity's plugin), and
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
  to exit (Claude Code takes about 100 ms), so each gets three seconds to end by itself.
  One still running then is ended with SIGTERM, then SIGKILL two seconds later, each
  signal sent only once the process is checked to be the same one, and fails the test,
  named by its command. It looks again, up to five times, until it finds no process it
  hasn't seen. Should the test end early, its teardown does the same, and fails the test
  for any process it had to end.
- **Enter only on text seen to land.** A deck terminal's `submit` types the text, waits
  until the screen shows it once more than it did before, and only then presses Enter.
  `press` refuses anything holding a carriage return or line feed, the keypad's Enter
  (`\x1bOM`) or the kitty keyboard protocol's (`\x1b[13u`, `\x1b[13;…u`). The one
  deliberate Enter is `confirm(shows, trigger)`. It counts what the screen shows of the
  expected option or dialog, runs `trigger`, the action that brings it up, and presses
  Enter only once the screen shows it once more. Text left from an earlier dialog can't
  let it through, and a dialog drawn before `trigger` returns isn't missed:
  `await t1.confirm("Allow this tool?", () => t1.submit("Run the tool"))`.

## Writing a scenario

Messaging scenarios live in `messaging.e2e.ts`, written once and run for every harness
in `setups` (`agents/index.ts`):

```ts
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("takes a prompt to the model and shows its reply", async ({ e2e: run }) => {
      run.model.use(replies("Say the word", "Pelican-7 says hello."))
      const t1 = await start(run, setup)

      await turn(t1, setup, "Say the word", "Pelican-7 says hello.")

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
  `refused`) or a known gap in `known-gaps.ts`, which picks the documented detour
  (`ringsAtReady`, `ringsAfterTurn`, `turnEnds`). A `<harness>.e2e.ts` holds only what
  is truly that harness's own, such as a known gap's pin.
- `e2e(...setups)` gives each test a fake model, a sandbox and a deck, with each
  setup's harness installed (once, before its tests), seeded and connected to NovaDeck
  through its own plugin commands. With several setups, as for a scenario across
  harnesses, their dialects share one fake model.
- **The fake model** answers each call with the first rule that replies; `model.use`
  adds rules ahead of the earlier ones, and with none it answers "OK.". Rules may be
  async: a rule that awaits a `gate()` holds its reply, and so keeps that turn running,
  until the test calls `open()`. The call is recorded as it arrives, before any rule
  answers. A `Call` is the same shape for every API; its latest user turn includes what
  a hook added beside the prompt, and `side` marks a call the harness makes for itself,
  such as a title. `model.mark()` and `waitFor(match, { after })` wait only for calls
  made after a point, so a second call of the same kind isn't mistaken for the first.
- **Helpers** in `scenarios.ts` make most scenarios a few lines: `start` opens a
  terminal and waits for Ready; `turn` submits a prompt, waits for its reply on screen
  and for the turn to run and end; `replies` and `sends` are rules that answer a prompt
  with text or with a `send`; `own` keeps a rule off side calls; `deliveries(call)`
  parses the `<novadeck-messages>` a hook added, plain or HTML-escaped, into
  `{ from, text }`; `ring` matches the doorbell's line.
- **NovaDeck's state** is recorded as it changes, not polled: each deck terminal keeps
  the history of its delivery state and its messages' states from the moment it opens.
  `t.mark()` and `t.reached(state or predicate, { after })` wait for a transition after
  a point, and `through(t, steps, { after })` for several in order, such as
  `["ringing", "working"]` or `holds("t1", "t2", "delivered")`. Each step is met at or
  after the one before it, in the same snapshot or a later one, as changes the runner
  makes in one go arrive together. On a timeout they fail with every transition since
  the mark (`t2: ready → ringing → unknown`), and `through` also says which steps were
  met (`met: ringing; waiting for: working`), so a failure says what happened. A test
  that throws fails its own wait, with its error, and no other.
- **Holding a turn** pins down how something travels. The round trip holds t2's answer
  at a `gate()` until t1's turn has ended, and asserts t1 is then rung; where a harness's
  turn end can't be rung yet (a known gap), it holds t1's turn open instead, so the
  answer comes as its Stop continuation.
- Prefer asserting on what the model received and on NovaDeck's state over reading the
  screen; read the screen for what only it shows, such as a reply rendered.

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
   - `prepare(sandbox, model, installed)` seeds its configuration in the sandbox so it
     starts at its own prompt with no screen in between, for the version actually
     installed, and returns the environment that points it at the fake model with the
     fake credential. `connected`, when given, runs once NovaDeck's plugin is connected
     and before any harness starts, for setup only the plugin's files make possible.
   - Its traits: `name`; `banner`, text on its first screen; `bindsAtReady`, whether
     its session binds before its first prompt; `hosts`, its real API and login hosts,
     which no request may try; and `refused`, hosts it tries that no setting turns off.
   - `watch`: the paths in the developer's home its tripwire checks, searched for the
     sandbox's root, listed by entry name, or stamped by time and size.
4. Add the setup to `setups` in `src/e2e/agents/index.ts`. That one list drives the
   messaging scenarios and the tripwire, so every scenario runs for it and its home is
   watched. A gap it shows goes in `known-gaps.ts`, with the test that pins it.
5. Add it to the CI matrix in `.github/workflows/e2e.yml`, with its display name.

## Claude Code against the fake model

- **Seeding.** Its config folder is `<sandbox home>/.claude`, set as `CLAUDE_CONFIG_DIR`.
  Its `.claude.json` there marks onboarding done, picks a theme, records the installed
  version's onboarding and release notes as seen (the version installed, not the pin, so
  a run against `latest` shows no release notes), turns auto-updates off, approves the fake key (by its last 20
  characters), and trusts the project. `settings.json` allows NovaDeck's MCP tools
  (`mcp__plugin_novadeck_novadeck`).
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
  from chatgpt.com.
- **Hook trust.** Codex runs a plugin's hooks only once trusted, and NovaDeck counts
  its prompt only then. Once the plugin is connected, `connected` starts the pinned
  `codex app-server` and makes the calls its "Hooks need review" screen makes:
  `hooks/list` for each hook's current hash, then `config/batchWrite` to record them
  as trusted, and to let NovaDeck's MCP tools run without asking. It copies the hashes
  rather than computing them, so it holds as long as that protocol does, which NovaDeck's
  own trust check relies on too.
- **What it calls.** 0.159.3 sends its model calls to `POST /v1/responses`, and asks
  `GET /backend-api/plugins/featured`, which the dialect answers with none. MCP tools
  are offered in a `namespace` (`mcp__novadeck`), and the dialect names them
  `mcp__novadeck.send`. A prompt hook's context arrives as a developer message after
  the prompt; a Stop hook's reason as a user message `<hook_prompt>`, HTML-escaped. A
  call is `side` when its `x-codex-turn-metadata` says it isn't the agent's turn, as
  its thread's title.
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
  NovaDeck's MCP tools (`mcp(novadeck_novadeck/*)`) to run without asking.
  `AGY_CLI_DISABLE_AUTO_UPDATE` stops it updating itself.
- **What it calls.** 1.2.14 streams each model call from
  `POST /v1beta/models/<model>:streamGenerateContent?alt=sse`; its session's title is a
  call with no tools, so `side`. MCP tools are lazy: it offers one `call_mcp_tool` and
  lists NovaDeck's tools in its system prompt, so the dialect offers them by the names
  Antigravity gives tools it loads (`mcp_novadeck_novadeck_send`), and encodes a call to
  one as `call_mcp_tool`. A `PreInvocation` hook's message arrives as a user content just
  after the prompt.
- **Refused tunnels.** Its feature flags (`antigravity-unleash.goog`) and telemetry
  (`play.googleapis.com`) go through the proxy, which refuses them; they are its setup's
  `refused`.
- **The keyring.** Signed in on the machine, Antigravity reads its login from the secret
  service whatever HOME says. The sandbox's dead D-Bus address is what keeps it out.

## Known gaps

`known-gaps.ts` names each one, with the harnesses it affects. The messaging scenarios
ask it which detour to take, so fixing a gap means taking its harness out of the entry.
Each is also pinned by a test that asserts today's wrong behaviour, so it can't pass
unnoticed: once fixed, that test fails and says what to assert instead.

- **A Codex at its first screen can't be rung** (`unrungAtFirstScreen`, read through
  `ringsAtReady`). Wide and tall enough, Codex draws a logo on its first screen and erases
  it as soon as anything lands in its input box. The doorbell's test paste then changes
  rows far from its line, and the ring fails as it should when it can't tell what the
  paste did. `codex.e2e.ts` pins it ("can't ring a Codex still at its first screen": the
  recipient goes ringing → Unknown, never Working, its message still queued), and the
  round trip gives the recipient one turn first. Once the doorbell rings such a Codex,
  assert it Working with the message delivered there, and take Codex out of the entry.
- **Antigravity often ends a turn Unknown** (`unknownTurnEnd`, read through `turnEnds`
  and `ringsAfterTurn`). Its status line still says it is working 10 to 60 ms after its
  Stop hook, which NovaDeck takes for the turn going on; the idle that follows then
  leaves the terminal Unknown, never rung, in about two turns in five. The race is
  pinned deterministically in `src/messaging/messaging.test.ts` ("is left Unknown when
  its status line says working just after a Stop, then idle"). Meanwhile its turns may
  end Settled or Unknown, and in the round trip the sender's reply after sending waits at
  a `gate()` until the answer is queued for it, so the answer comes as its Stop
  continuation rather than a ring. Once fixed, assert Settled in that unit test and take
  Antigravity out of the entry.
