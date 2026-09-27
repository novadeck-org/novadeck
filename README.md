# NovaDeck

A terminal workspace for organizing projects, sessions, and parallel work.

Focus on one terminal, arrange several in a grid, or spread them across a zoomable
canvas. Keep related work together and switch between sessions from the sidebar.

In Canvas, scroll to zoom in or out, and drag the background or an inactive terminal
to pan. Click a terminal to activate it, then select its text, scroll its output,
or drag its header to move it. Activating a terminal brings it in front of the
others; Canvas retains that stacking order until you leave the view.
Double-click or double-tap a terminal header outside its name to smoothly center and zoom that terminal
to fit the canvas viewport. Repeat the gesture on the same terminal to return to the
previous camera position and zoom. Manual pan or zoom (including keyboard shortcuts),
Fit all, sidebar camera navigation, leaving Canvas, or switching sessions clears that
return point. Flying to a different terminal starts a new visit from the current camera.
Repeated double gestures during a flight are ignored. Minimized terminals restore first;
returning the camera does not minimize them again. The header's arrow opens Focus view.

Click **New terminal** or use its keyboard shortcut to create and select a terminal
immediately in any view, with or without Zen. Focus shows it right away. Grid uses
an available slot and scrolls it into view. Canvas chooses a nearby free position,
preferring the current viewport, and pans only as needed to reveal it without changing
zoom. Terminals can be moved or resized immediately; there is no placement step.
Right-click the Grid or Canvas background and choose **Terminal** to create one without entering
rename mode. In Canvas, its top-left corner is placed at that canvas point without moving the
camera. Terminals created with the New terminal control open in rename mode with their name
selected: in the sidebar when visible, or in the terminal header otherwise. Enter or clicking
away saves the name; Escape keeps the original name. In any
view, double-click or double-tap a terminal's name in its header to rename it
directly; in the sidebar, use the tab's Rename button or F2. The header and sidebar share rename mode and
the live draft. Move between either name field to continue editing; saving or
canceling ends the edit in both places.

Use the terminal header's resize control to alternate between two sizes. In Canvas,
**Enlarge** matches the current Canvas viewport aspect ratio at a fixed area equivalent
to 1200×800, independent of zoom. **Compact** sets 600×400. Extreme ratios respect the
minimum terminal dimensions. Double-click the enlarged terminal header to fill more
of the viewport. Canvas grows or shrinks around the terminal's center
without changing the camera. In Grid, **Make full width** fills the available columns;
**Restore width** returns to the width at each breakpoint from before that click,
preserving terminal height. Resizing restores minimized terminals.
Preset choices are remembered per terminal, session, and view. New terminals start
compact: 600×400 in Canvas and compact column width in Grid, with no placement preview.

In Grid, selecting a terminal from its tab smoothly scrolls it into view. With
reduced motion enabled, it scrolls immediately.
Double-clicking or double-tapping a Focus or Grid terminal header outside its
name has no effect; use the header action to move between those views.

Use the eye on a terminal tab to hide it from Grid and Canvas without closing it.
Hidden tabs stay in the list with a faded label. While selected, a hidden terminal
appears at 50% opacity in Grid and Canvas, then disappears when it is no longer active.
Its hidden setting stays unchanged; use the eye to make it visible permanently.
Hidden terminals retain
their content and layout and remain available in Focus view.
Showing and hiding use a short fade and scale transition; reduced motion skips it.
Switching terminal tabs in Focus uses the same transition.

## Zen mode

Choose **Enter Zen mode** in the top bar to hide the header, sidebar, rail, and footer
without leaving the current Focus, Grid, or Canvas view. The floating dock provides
New terminal, enabled view choices, and Exit Zen. At rest it folds to New terminal and a
small chevron. Click or tap the chevron to toggle the remaining controls, or activate
it with Enter or Space. Clicking outside, leaving with keyboard focus, or pressing Escape folds it again.
Canvas navigation uses gestures and
keyboard shortcuts: +/− to zoom and 0 to fit all terminals.
Focus becomes an edge-to-edge terminal, while Grid and Canvas gain the available space.
In any view, click the terminal icon beside the name to open the terminal switcher.
Choose a terminal, or use Up/Down and Enter. Escape closes the switcher.
This also works outside Zen; double-click or double-tap the name still renames it.
Terminal names stay visible; header actions appear on hover or keyboard focus on desktop
and stay visible on touch devices. Search and terminal shortcuts remain available.

Zen preserves the active terminal and Canvas camera on entry. Exit Zen restores the
previous sidebar visibility and panel. Explicit sidebar shortcuts or Browse sessions
leave Zen to show the requested panel. Zen is temporary and resets on reload.

## Keyboard shortcuts

| Action                                            | macOS            | Windows and Linux  |
| ------------------------------------------------- | ---------------- | ------------------ |
| Find a terminal                                   | `Cmd+K`          | `Ctrl+Shift+K`     |
| Recent terminals                                  | `Ctrl+Tab`       | `Ctrl+Tab`         |
| Cycle backward through recent terminals           | `Ctrl+Shift+Tab` | `Ctrl+Shift+Tab`   |
| Toggle Focus and the previous Grid or Canvas view | `Cmd+Enter`      | `Ctrl+Shift+Enter` |
| New terminal                                      | `Cmd+T`          | `Ctrl+Shift+T`     |
| New session in the current project                | `Cmd+Shift+N`    | `Ctrl+Shift+N`     |
| Toggle terminal sidebar                           | `Cmd+Shift+1`    | `Ctrl+Shift+1`     |
| Toggle session sidebar                            | `Cmd+Shift+2`    | `Ctrl+Shift+2`     |
| Open preferences                                  | `Cmd+,`          | `Ctrl+,`           |

When navigating the workspace outside terminal input, text editors, and dialogs,
these simpler keys work in both normal and Zen mode:

| Key      | Action                                            |
| -------- | ------------------------------------------------- |
| `T`      | New terminal                                      |
| `/`      | Find a terminal                                   |
| `F`      | Toggle Focus and the previous Grid or Canvas view |
| `Z`      | Toggle Zen                                        |
| `B`      | Toggle terminal sidebar (leaves Zen to show it)   |
| `F2`     | Rename the active terminal                        |
| `Delete` | Close the active terminal                         |

The modifier shortcuts above remain available from terminal input. Workspace keys
never replace typing, editing, or dialog navigation.

The new-session shortcut creates and selects an empty session in the current project
and opens the Sessions sidebar.

Sidebar shortcuts open or switch to their panel; pressing the same shortcut again hides it.

Hold Ctrl while pressing Tab to choose a terminal, then release Ctrl to switch.
Up and Down select terminals in sidebar order in Focus, Grid, and Canvas, wrapping
at either end. Selection pans Canvas or scrolls Grid just like clicking a tab.
Left and Right cycle through enabled views in Focus → Grid → Canvas order, wrapping
at either end and retaining the selected terminal.
Escape first deselects the active terminal in any view, then hides the open sidebar
on the next press. Further presses do nothing. Focus keeps the displayed terminal
in place; clicking it activates it again. Terminal input, editors, and dialogs
retain Escape without changing workspace selection.
Text inputs and open dialogs retain their own arrow behavior. Arrow keys no longer
pan the canvas camera. While the recent switcher is open, Up and Down cycle its list.
The new-terminal shortcut creates a terminal immediately and opens the desktop Terminals sidebar
when outside Zen. On narrow screens the sidebar stays closed so the new terminal is visible. The name editor receives focus. These shortcuts are available in the desktop app; browsers may
reserve `Ctrl+Tab` for changing browser tabs. The Shortcuts tab in Preferences
groups bindings into Anywhere and Workspace for the current platform. On the Canvas
background, `+`/`−` zoom and `0` fits all terminals.

## Development

Requires Node.js 26 and pnpm 11.22.0. Run commands from the repository root.

```sh
pnpm install
pnpm dev
```

`pnpm dev` launches the Electron desktop application. To run the UI and runner
in a browser instead:

```sh
pnpm dev:web
```

Open <http://127.0.0.1:5173>. For UI-only work, use
`pnpm --filter @novadeck/ui dev`.

## Repository map

This is a TypeScript monorepo using pnpm workspaces and Turborepo.

| Package                | Responsibility                                                  |
| ---------------------- | --------------------------------------------------------------- |
| `application/ui`       | React frontend built with Vite, Tailwind CSS, and Lucide icons. |
| `application/runner`   | The runner: shells and metadata, served over WebSocket or port. |
| `application/protocol` | Shared Zod contracts and the `connectRunner` client for UIs.    |
| `application/host`     | Electron host that starts the runner and loads the packaged UI. |
| `scripts`              | Repository checks and automation.                               |

The terminal interface currently uses sample output and in-memory commands, not
real shell processes or model calls. Projects, sessions, and layouts reset on
reload; preferences and sidebar settings are stored locally. Keep this boundary
in mind when changing terminal behavior or adding runner integration.

See the [terminal backend plan](docs/backend-plan.md) for the proposed runner
architecture and typed API.

The standalone backend now supports authenticated, real terminal processes and
persistent project/session metadata. The Electron host runs it in a utility process,
but the interface above is **not connected yet** and still uses mock data. See the
[backend API guide](docs/backend-api.md) for configuration, client examples, and
backend-only tests.

### Working on the UI

Source lives in `application/ui/src/`, grouped in layers:

| Location                                           | What belongs here                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `app/`                                             | Composition root: router, provider, backend selection, and the page sections.           |
| `app/ui-store.ts`                                  | The UI store: route, preferences, shell, rename, switcher, and its store subscriptions. |
| `app/selectors.ts`                                 | Pure reads over the stores that sections, commands, and keys share.                     |
| `app/commands/`                                    | Commands, key commands, and the navigator: plain functions over both stores.            |
| `app/controller/`                                  | React glue: context, selector hook, route sync, keyboard dispatcher, effects.           |
| `backend/`                                         | The UI-owned backend port and the shared terminal lifecycle registry.                   |
| `backend/demo/`                                    | The demo adapter: sample projects, simulated terminals, and their surface.              |
| `model/`                                           | Pure domain: types, reducer, workspace store, seed, and layout rules in `layout/`.      |
| `model/roster.ts`                                  | A session's terminals, their sidebar order, and their status.                           |
| `model/layout/workspace-layout.ts`                 | Where each terminal sits and how big it is in each view.                                |
| `terminals/`                                       | Terminal frame, tabs, rename state, and the recent-terminal switcher.                   |
| `layouts/canvas/`, `grid/`, `focus/`               | View adapters and colocated library styles.                                             |
| `layouts/` (top level)                             | Helpers shared by views: view transitions, background gestures, visibility.             |
| `shell/`                                           | Header, rail, panels, zen dock, sidebar, and shell state transitions.                   |
| `sidebar/`, `projects/`, `preferences/`, `search/` | Feature components.                                                                     |
| `interaction/`                                     | Shortcut records, the keymap, and shared DOM focus/overlay contracts.                   |
| `ui-toolkit/`                                      | Reusable styled controls and direct Ark UI imports.                                     |
| `test/`                                            | Unit-test fixtures, a jsdom render helper, a command harness, and the port contract.    |
| `assets/`                                          | Static files referenced from CSS.                                                       |
| `styles.css`                                       | Theme tokens, global primitives, and shared workspace styles.                           |
| `specs/`                                           | Behaviour specs for the whole UI, run in a real browser.                                |

Imports point down the layers. `model/` imports nothing else, not even packages.
`backend/` builds on `model/` and uses React only for the port's types; adapters
may add `ui-toolkit/`. `interaction/` builds on `model/` and imports no packages;
features add `ui-toolkit/`; `terminals/` may use `sidebar/`; `layouts/` may use
`terminals/`; `shell/` may use `layouts/` and `projects/`. `app/` composes every
feature layer and `backend/`, and within it only `app/backend.ts` imports a
backend adapter. `app/commands/` has no direct React or package imports, though
routing still loads React Router at runtime: it builds on `model/`,
`interaction/keymap.ts`, `backend/port.ts`, the UI store, routing, selectors,
the Canvas handle type in `layouts/canvas/types.ts`, and the pure state modules
of `shell/` and `terminals/`. Vendor
libraries stay in their adapters: XYFlow in `layouts/canvas/`, React Grid Layout
in `layouts/grid/`, Allotment in `shell/`, dnd kit in `terminals/`, Ark UI in
`ui-toolkit/`, React Router in `app/` and `shell/`, and React DOM in
`layouts/transition.ts`, `main.tsx`, and `test/`. Other packages are denied
unless the test lists them: React and Lucide are allowed everywhere, while
backend adapters and test code may use any package. `test/` may import
`model/`, `backend/`, and what the command harness runs: `app/commands/`, the UI
store, routing, and the Canvas handle type. Hooks declare named contracts instead of
`ReturnType<typeof useHook>`. `src/architecture.test.ts` enforces these rules and
fails for a source file that belongs to no layer.

Navigation uses React Router with hash URLs in both the browser and Electron,
so links work with the packaged `file://` UI and static hosting. For example:

```text
#/projects/storefront/sessions/initial/canvas?terminal=05&panel=sessions
```

The path selects a project, workspace session, and view. Query parameters select
the terminal, sidebar panel, and dialog (`dialog=search` or `dialog=preferences`);
Preferences also accepts `section=shortcuts`. Back and Forward restore navigation
without discarding terminal drafts or output. Sidebar visibility, search text,
canvas gestures, and other temporary controls stay out of the URL.

Sample sessions use the stable ID `initial`. New sessions still live only in
memory: reloading an expired session link falls back to that project's available
session. Unknown routes, missing terminals, and disabled views are replaced with
a valid URL. Routing does not persist terminal data across reloads.

The page renders from two synchronous stores only. The workspace store in
`model/store.ts` holds the model: every session's roster, layout, and navigation
memory, changed through one pure reducer. The UI store in `app/ui-store.ts`
holds what the model does not own: the current route, preferences, the shell
state from `shell/shell-state.ts`, the rename in progress, the recent-terminal
switcher and each session's most-recent order, and the new-terminal highlight.
It starts over on reload apart from preferences and the collapsed sidebar, which
store subscriptions persist. Another subscription saves the active session's
windowed view from the workspace store, and a new App seeds sessions with it. `WorkspaceProvider` creates
the backend, both stores, the navigator, and the commands once per App, in a
pure initializer, and shares them through context; it receives the page as
children, so a URL change re-renders only the provider.

The URL owns current navigation; the workspace model remembers each session's
last selection. The navigator in `app/commands/navigator.ts` commits a
destination's workspace actions and route to the stores before it asks the
router to navigate, so a command's changes and its URL render together. The
route sync in `app/controller/useRouteSync.ts` is the one place the URL enters
the stores: in a layout effect it reconciles Back, Forward, typed URLs, and
preference changes against the latest model and replaces a URL that names
something unavailable. A session change starts the shell's presentation over in
the same commit, through a store subscription, and Back or Forward does the same
from route sync, so a view that mounts next already sees it.

Commands in `app/commands/` are the operations the pointer UI and the keyboard
share. They are plain functions that read the latest stores when they run, so
several in one event retain one another's changes; construct an action from
command-time state when it depends on a counter or the current selection. They
reach the page (focus, view transitions, timers, the clock, ids) only through the
`CommandEffects` that `app/controller/effects.ts` supplies, and tests pass their
own. Address updates by project and session IDs so delayed callbacks affect
their original session or become a no-op after it is removed: layout callbacks
take the target their view rendered with, because Canvas saves its geometry when
it unmounts after a session switch.

Keyboard shortcuts are data. `interaction/keymap.ts` lists every binding by
layer and routes a key from its input, the kind of element it was pressed on,
and the store state, without touching the DOM; `app/commands/keys.ts` maps each
command id onto the commands, and `app/controller/useKeyboard.ts` listens on
window in the capture and bubble phases of keydown, and for keyup and blur.
Preferences renders its shortcut table from `shortcutGroups`. Canvas keeps its
own zoom keys.

Sections in `app/` subscribe to just what they render with `useWorkspaceState`
and `useUiState`, built on `useStoreSelector`, and share selectors from
`app/selectors.ts`. Each terminal frame and sidebar tab selects by its own
terminal, so a rename keystroke re-renders only that tab and frame. A Canvas
layout save re-renders the stage section, Canvas, and the terminals on it, but not
the header, sidebar, tabs, or overlays. Effects that must follow a commit, such as
saving a rename left behind, live in `app/controller/useWorkspaceEffects.ts`.
Feature components outside `app/` take props.

Terminal metadata and saved layouts live in the workspace model. Everything
else about a terminal belongs to a backend behind the port in `backend/port.ts`:
it supplies the starting workspace seed, allocates new terminals synchronously,
sees every store commit before listeners run, and renders the content inside
each terminal frame. A surface marks the element that takes typed input with
`data-terminal-input`, so shortcuts treat it as terminal input. The demo adapter
keeps drafts, output, and scroll offsets per terminal with one subscription
each, so output does not trigger workspace-wide renders. A terminal's
presentation can unmount during view or session changes without losing that
state; closing the terminal removes it. `backend/registry.ts` provides this
lifecycle for any adapter. An adapter opts into the port contract suite by
calling `describeBackendContract` from `test/backend-contract.tsx` in a
colocated `contract.test.ts`, with a probe of what it holds and the I/O it
started, and a driver when it has `start`. `App` reads a `createBackend` factory
once at mount, and `app/backend.ts` chooses the default.

A backend reports changes of its own, such as a process exiting or failing to
start, through the optional `start`. It runs from an effect after mount and
receives a sink that commits each call as one store transaction, like a UI
command; the sink ignores stale targets and anything sent after stop. The frame
labels an exited or failed terminal. Terminal listings after a reconnect,
waiting for an asynchronous seed or connection, and disposing a backend arrive
with the runner adapter. Workspace sessions are still created in the UI, outside the port.

XYFlow owns live Canvas gestures; save geometry and camera state when a gesture
ends or the view unmounts. Grid, Canvas, Preferences, and search load on demand.
Keep vendor-specific types and CSS inside their adapters, and use
application-owned types for saved layouts.

Keep direct Ark UI imports in `ui-toolkit/`; features own their content and state.
Use Tailwind utilities for ordinary component styling. See [CODING.md](CODING.md)
for broader conventions.

### UI behaviour specs

`src/specs/` describes the UI the way a person uses it and guards the UX while
the implementation changes. Each spec renders the whole app in headless Chromium
with real CSS, layout, pointer, and keyboard input. The main behaviour project
enables reduced motion; the smaller motion project exercises ordinary transitions.
Specs find elements by accessible role, name, or text, and assert only what a
person can observe: what is visible, focused, selected, or where it sits on
screen. They never import components, mock app modules, or select by CSS class,
so a refactor that keeps the UI intact keeps them green. `specs/support/` holds
the shared vocabulary (for example `openWorkspace`, `terminal`, `chooseView`);
when markup changes on purpose, update it there. If a behaviour can't be reached
through accessible markup, improve the markup rather than adding test IDs.

Install the browser once with `pnpm --filter @novadeck/ui exec playwright install chromium`.
Run a single spec with `pnpm --filter @novadeck/ui exec vitest run --project behaviour src/specs/canvas.spec.tsx`,
or `--project unit` for reducer invariants, terminal lifecycle, layout rules,
stores, commands, keymap routing, render scope, architecture rules, and build
checks in colocated `*.test.ts` files. Files in `src/specs/` keep
the `*.spec.tsx` suffix. Use `--project motion` for transition behavior. The build
checks validate both entry assets and deferred chunks with relative packaged paths.

## Configuration

For standalone UI/runner configuration, copy the environment templates:

```sh
cp application/ui/example.env application/ui/.env
cp application/runner/example.env application/runner/.env
```

- UI: `VITE_API_URL` sets, at build time, the API origin that the Content Security
  Policy permits; by default only the same origin. The UI does not call the API yet.
- Runner: `HOST`, `PORT`, and `CORS_ORIGINS` control the listener and allowed frontend origins.
- Terminal API: `NOVADECK_TOKEN` enables authenticated WebSocket RPC;
  `NOVADECK_DATABASE` optionally selects the SQLite metadata file. Without a token,
  only the existing HTTP status API is available.
- Electron: the host runs the runner in a utility process and hands each window a
  MessagePort through a sandboxed preload bridge. It also serves the status endpoint
  on a local, OS-selected port. Package `.env` files are not used.

For a separately hosted frontend, set `VITE_API_URL` to the public HTTPS API URL
before building and add the frontend origin to `CORS_ORIGINS`. The generated
Content Security Policy permits the configured API origin. Local `.env` files
are ignored; never commit credentials.

## Validation

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Use package filters for focused checks, for example `pnpm exec turbo run test --filter=@novadeck/ui`,
which builds what the tests need first. `pnpm test` runs one package's tests at a time:
the UI's browser tests and the runner's real-PTY tests are timing-sensitive, and running
them together starved the smaller CI runners enough to time out.
Tests use Vitest: UI behaviour specs run in Vitest Browser Mode on Chromium, and
MSW covers HTTP behavior. The PR workflows run formatting, lint, typechecking,
builds, and PR metadata checks on Linux. The Test jobs run all package and repository
tests on Linux, macOS, and Windows, including for draft PRs. Each runs UI tests in
Chromium alongside backend API, real PTY, and built-CLI tests. The required `Test`
check passes only when the entire Quality matrix succeeds. PRs marked ready for review package
and smoke-test the app on Linux, macOS, and Windows using the same workflow as
releases. Draft PRs skip packaging; PR checks never create tags or publish releases.
Quality checks run on PR opening, reopening, and commits. Marking a draft PR ready
starts only the Release workflow, which reuses the matching Quality result before
packaging and smoke testing. Release preparation, tagging, and publishing are
disabled for PR runs.

## Packaging and releases

```sh
pnpm package:linux
pnpm package:mac
pnpm package:win
```

Artifacts go to `application/host/release/`: a Linux x64 AppImage, a macOS
universal ZIP, or a Windows x64 portable executable. Builds are unsigned, so
Gatekeeper or SmartScreen may warn. The application ID is `dev.mzpk.novadeck`.

The [release workflow](.github/workflows/release.yml) publishes immutable GitHub
prereleases from qualifying changes on `main`, with notes, checksums, and native
packages. It smoke-tests each packaged application before upload. Conventional
Commits determine release eligibility; versions are currently limited to patch
increments. Documentation-only changes do not trigger a release. See
[.release-it.json](.release-it.json) for the release configuration.

Promote tested binaries on GitHub Releases by clearing **Set as a pre-release**
and selecting **Set as the latest release**; no rebuild is needed. For an
interrupted release, inspect the latest workflow first. An unpublished draft or
orphaned version tag must be cleaned up before rerunning the latest release
workflow; published immutable releases must remain intact.

## Contributing

Start with [AGENTS.md](AGENTS.md) for the required reading,
[CONTRIBUTING.md](CONTRIBUTING.md) for the issue and PR workflow, and
[CODING.md](CODING.md) for code and test conventions. Follow
[SECURITY.md](SECURITY.md) for credentials and vulnerability reports.
