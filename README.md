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

`pnpm dev` launches the Electron desktop application. To run the UI and runtime
in a browser instead:

```sh
pnpm dev:web
```

Open <http://127.0.0.1:5173>. For UI-only work, use
`pnpm --filter @novadeck/ui dev`.

## Repository map

This is a TypeScript monorepo using pnpm workspaces and Turborepo.

| Package               | Responsibility                                                   |
| --------------------- | ---------------------------------------------------------------- |
| `application/ui`      | React frontend built with Vite, Tailwind CSS, and Lucide icons.  |
| `application/runtime` | Hono API running on Node.js, independent of frontend delivery.   |
| `application/host`    | Electron host that starts the runtime and loads the packaged UI. |
| `scripts`             | Repository checks and automation.                                |

The terminal interface currently uses sample output and in-memory commands, not
real shell processes or model calls. Projects, sessions, and layouts reset on
reload; preferences and sidebar settings are stored locally. Keep this boundary
in mind when changing terminal behavior or adding runtime integration.

### Working on the UI

Source lives in `application/ui/src/`:

| Location                                                               | What belongs here                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `app/`                                                                 | App composition and browser effects.                                    |
| `ui-toolkit/`                                                          | Reusable styled controls and direct Ark UI imports.                     |
| `workspace/model/`                                                     | Shared types, the pure workspace reducer, and selectors.                |
| `workspace/terminals/`                                                 | Terminal cards and sortable tabs.                                       |
| `workspace/layouts/`                                                   | Grid and Canvas views, layout logic, and view transitions.              |
| `workspace/sidebar/`, `projects/`, `preferences/`, `search/`, `shell/` | Feature components, navigation, and app chrome, all under `workspace/`. |
| `workspace/mock/`                                                      | Sample projects, transcripts, and command replies.                      |
| `styles.css`                                                           | Theme tokens, global primitives, and specialized library/canvas styles. |
| `specs/`                                                               | Behaviour specs for the whole UI, run in a real browser.                |

Navigation uses React Router with hash URLs in both the browser and Electron,
so links work with the packaged `file://` UI and static hosting. For example:

```text
#/projects/storefront/sessions/initial/canvas?terminal=05&panel=sessions
```

The path selects a project, workspace session, and view. Query parameters select
the terminal, sidebar panel, and dialog (`dialog=search` or `dialog=preferences`);
Preferences also accepts `section=shortcuts`. Back and Forward restore navigation
without discarding terminal drafts or output. Sidebar visibility, search text,
canvas gestures, and other temporary controls stay local.

Sample sessions use the stable ID `initial`. New sessions still live only in
memory: reloading an expired session link falls back to that project's available
session. Unknown routes, missing terminals, and disabled views are replaced with
a valid URL. Routing does not persist terminal data across reloads.

Keep project and session data in the workspace reducer; the URL owns the current
navigation, while the reducer remembers each session's last selection. Address updates by
project and session IDs so delayed callbacks affect the session that created
them. XYFlow owns live Canvas gestures; save geometry and camera state when a
gesture ends or the view unmounts.

Keep direct Ark UI imports in `ui-toolkit/`; features own their content and state.
Use Tailwind utilities for ordinary component styling. See [CODING.md](CODING.md)
for broader conventions.

### UI behaviour specs

`src/specs/` describes the UI the way a person uses it and guards the UX while
the implementation changes. Each spec renders the whole app in headless Chromium
with real CSS, layout, pointer, and keyboard input, and reduced motion enabled.
Specs find elements by accessible role, name, or text, and assert only what a
person can observe: what is visible, focused, selected, or where it sits on
screen. They never import components, mock app modules, or select by CSS class,
so a refactor that keeps the UI intact keeps them green. `specs/support/` holds
the shared vocabulary (for example `openWorkspace`, `terminal`, `chooseView`);
when markup changes on purpose, update it there. If a behaviour can't be reached
through accessible markup, improve the markup rather than adding test IDs.

Install the browser once with `pnpm --filter @novadeck/ui exec playwright install chromium`.
Run a single spec with `pnpm --filter @novadeck/ui exec vitest run --project behaviour src/specs/canvas.spec.tsx`,
or `--project unit` for the non-UI unit tests.

## Configuration

For standalone UI/runtime configuration, copy the environment templates:

```sh
cp application/ui/example.env application/ui/.env
cp application/runtime/example.env application/runtime/.env
```

- UI: `VITE_API_URL` sets the API URL at build time; the default is same-origin `/api`.
- Runtime: `HOST`, `PORT`, and `CORS_ORIGINS` control the listener and allowed frontend origins.
- Electron: the host starts the bundled runtime on a local, OS-selected port and
  supplies its URL through a sandboxed preload bridge. Package `.env` files are not used.

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

Use package filters for focused checks, for example `pnpm --filter @novadeck/ui test`.
Tests use Vitest: UI behaviour specs run in Vitest Browser Mode on Chromium, and
MSW covers HTTP behavior. The PR workflows run formatting, lint, typechecking, tests,
builds, and PR metadata checks on Linux. PRs marked ready for review package
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
