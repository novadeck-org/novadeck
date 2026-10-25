# The real-hardware profile

Step 1.7's tooling (rule 18): the packaged desktop app, Electron with the GPU on, run through the
timing run's scenario and a heavy one, with a Chromium trace of every phase, and the main
thread's time split by what it went to. Its numbers are the baseline steps 4.0 and 6.0 read, once
recorded on a named machine in performance.md, and the numbers the plan's triggers read.

```sh
pnpm bench:profile [--machine <name>] [--runs <n>] [--scenario timing|heavy]… \
  [--variant production|profiling]… [--terminals <n>] [--window <width>x<height>] \
  [--contexts <n>] [--software-webgl] [--output <folder>] \
  [--switch <chromium switch>]… [--note <text>]
```

It packages the app unpacked (`pnpm --filter @novadeck/desktop package`), then:

1. builds the UI again without the bench's patches and checks that every script it built is
   byte for byte the packaged one, which says the builds below are made of the package's
   source; should any differ, `problems` says so;
2. builds each variant's UI (`build.ts`) with the bench-only patches (`patches.ts`, below)
   and puts it in a copy of the package: the production build (`production`), or the same
   with React DOM's profiling build in place of its production one (`profiling`), the
   maps of the very build that runs describing it; the copies are removed at the end;
3. for each run, the scenarios and builds taking turns, makes a sandbox as the timing run does
   (`../timing/sandbox.ts`): a throwaway home with Novadeck's plugin on in
   `.claude/settings.json`, and a PATH whose only `claude` is the fake agent; it refuses to start
   if any other folder on that PATH holds `claude`, `codex` or `agy`;
4. launches the build in it through Playwright's Electron driver, its window's content 1440×900,
   shown and in front;
5. plays the scenario (`drive.ts`): `--terminals` terminals (13 by default), Grid then Focus on
   agent 1, a steady window in each (5 s warm-up, 15 s traced), then 2 passes of the
   switches (up to 15 a pass) in Focus, traced as one phase, and the memory sampled at the
   start and after each phase (see "Memory"). The timing scenario has the first 5 terminals
   running the fake agent, busy, and the rest idle shells; the heavy one has them all busy;
6. closes the app, reaps whatever still runs in the sandbox, checks the developer's home with
   the tripwire, removes the sandbox, and reads the run's traces.

`--machine` names the machine in the output, this computer's host name by default, and the output
folder is `.cache/bench/profile/<machine>` unless `--output` says otherwise, so a second machine's
profile sits beside the first's. `--runs` is 3 by default and every variant runs by default; a run
takes about 3 minutes, so the default, 3 runs of 2 scenarios on 2 builds, takes about
35 minutes. `--switch` passes Chromium a switch, as `--switch=--foo`; `--note` is kept in the
output, to say where it ran. It exits 1 should any run fail or the sandbox leak, having written
what it got; on SIGINT, SIGTERM or SIGHUP the app running closes and what the runs got is written,
and a second signal ends it at once. A signal while the app is still launching meets
Playwright's own handlers too, which on SIGINT end the process before the sandbox is reaped,
checked and written up; they go once the launch is done. Linux and macOS; on macOS the variants' copies are signed
again ad hoc, which hasn't been tried yet.

## Before running it on a real machine

It runs the real app on the real display, so whoever runs it on a personal machine says so
first. The app, the runner it starts and every shell get the sandbox's environment alone, plus
`DISPLAY` and `XAUTHORITY` to reach the X server, the shells included (an X session that sets no
`XAUTHORITY`, relying on `~/.Xauthority`, can't be reached from the sandbox's home: set it to that
file for the run): on Linux it draws through
X11, under a Wayland session through XWayland, since the sandbox's runtime folder holds no
Wayland socket. The unpacked package's `chrome-sandbox` isn't setuid, so on Linux it runs with
`--no-sandbox`, as the packaged smoke test does. The machine should be left alone while it runs:
the window must stay shown, as Chromium throttles a hidden one (each phase records whether the
page was visible and focused at its end).

Turn the desktop's display sleep and screen lock off for the run (on GNOME: Settings → Power →
Screen Blank, Never, which is `org.gnome.desktop.session idle-delay`; on macOS, the display's
sleep in Lock Screen settings): the run's input is synthetic, Playwright's, which the desktop
doesn't count as activity, so the screen blanks and locks a few minutes in, and Chromium then
draws the page at about a frame a second, though it still reads as visible and focused. A lock
started by hand does the same. The app can't hold the screen awake itself, as the sandbox gives
it no session bus. A phase whose compositor drew under 5 frames a second (its page's animation
frames, where its trace couldn't be read) is marked throttled: its numbers are left out of the
summary, its run out of the triggers, and profile.md lists it. The compositor tells a dark
screen from a busy page, as it draws on while the main thread is saturated; a screen that goes
dark partway through a phase isn't caught, so the run is best left alone with blanking off.

## A smoke test under a virtual display

```sh
xvfb-run -a -s "-screen 0 1920x1080x24" pnpm bench:profile --machine xvfb --runs 1 \
  --software-webgl --switch=--use-angle=swiftshader --switch=--enable-unsafe-swiftshader \
  --switch=--ignore-gpu-blocklist --note "xvfb smoke"
```

checks the plumbing without touching the real display. **Its numbers are a smoke test, not the
baseline**: Xvfb has no GPU, so Chromium draws in software, the switches give the WebGL
renderer SwiftShader's software WebGL to draw with, and `--software-webgl` makes the page's
pool take it (the pool refuses software WebGL, which draws slower than the DOM renderer, so
without the flag no screen would hold a context). profile.md says so in bold whenever the
trace or Electron shows software rendering.

## Terminals, window and the context cap

- `--terminals <n>` opens n terminals in each scenario (13 by default, at least 2): the timing
  scenario runs its first 5 on the fake agent, the heavy one all of them. The switches phase
  presses the same terminals whatever n is (those of the 13 the session has), so its times
  compare across counts. **Memory is reported against the terminals mounted** (screens in the
  page, `.xterm`; Grid mounts every one, Focus the few it keeps) and **time against the
  terminals in view** (a screen at least half inside the window); both are rows of the tables.
- `--window <width>x<height>` sets the window's content (1440×900 by default). **To have 20
  tiles in view the window is made bigger, not the tiles smaller.** The Grid puts two tiles
  across at any width above a phone's (a tile is half the Grid's width, `gridPresetWidth`)
  and a row of them takes 432 px (a tile is 400 px high, `gridTileHeight`, with its gaps)
  under 161 px of header, so n tiles in view need about 161 + 432 × n/2 px of height: 1440×900
  has 4 in view, 2560×2400 has 10 or 12, and 20 take about 4500 px, which only a virtual
  display has (`xvfb-run -s "-screen 0 1600x4600x24"` and `--window 1600x4500`); a real
  display's window is clamped to it. Tiles can't go small enough to help (the smallest is 240
  px high). On a real display, `--switch=--force-device-scale-factor=0.5` doubles the CSS pixels
  the window holds, but draws the terminals' text at half its size, which changes what the
  atlas holds: do not compare it with a run without. The "Terminals in view" row says what a run
  got.
- `--contexts <n>` raises the cap: it passes Electron `--max-active-webgl-contexts=n` and
  builds the page with a bench-only patch (`raisedCapPatch`, on
  `frontend/terminal-views/src/renderers.ts`) that makes the page's pool take n - 2 contexts,
  as its default of 14 is 16 less two. The run **fails** should a screen hold a lost context,
  or an addon be told one is lost, in any sample or phase: so a run with 20 or 40 terminals
  and `--contexts 40` that finishes shows no context was lost past 16. Without the flag the
  app raises the limit to 64 itself (the pool takes 62), and the page learns a limit given
  by the flag the same way, so the patch only restates it. A page of the browser build keeps
  14, and its screens past that draw with the DOM renderer.

## The bench-only patches

`patches.ts` holds what the profile adds to its builds, as Vite plugins in `build.ts`; none is
the product's, and each fails the build should the source it patches change shape. The
production build the profile runs is the package's UI built again with them (the build checks
first that the package is that source), and they keep every line where it was, for the maps:

- `profileTextPatch`: every screen's host gets `profileText`, which reads the rows its terminal
  shows from the buffer, as a WebGL screen has no text in the page and the timing driver reads
  `profileText` before `textContent`; every variant has it, as the pool puts any screen on WebGL;
- `webglAtlasPatch`: registers the live WebGL addons (`globalThis.__profileWebgl`) and counts
  the contexts they were told were lost, on the addon's bundle, so `gpu.ts` can read each one's
  texture atlas through the addon's private fields;
- `raisedCapPatch` (`--contexts`), above;
- `softwareWebglPatch` (`--software-webgl`), above;
- `storeSpansPatch`, in the profiling build, below.

## Memory

Memory is sampled outside the timed phases, as its dumps would load the main thread: at the start
(`boot`, no terminal), and after Grid, Focus and the switches. A sample (`memory.ts`) is:

- a three-second Chromium trace of the `disabled-by-default-memory-infra` category alone, with a
  detailed dump every 500 ms; the last complete one is read, for every process: its totals
  (`private_footprint_bytes`) and its allocator dumps two levels deep (`gpu/shared_images`,
  `skia/gpu_resources`, and in the renderer `webgl`, `cc/tile_memory`, `v8`...);
- Electron's `app.getAppMetrics()`: the working set, and the private bytes, which it gives on
  Windows only;
- on Linux, each process's `smaps_rollup` (private clean plus dirty), which gives the GPU
  process's private memory where Electron doesn't. (The page's `process.getProcessMemoryInfo()`
  isn't used: the renderer's sandbox doesn't expose it to the page, and the dump has the
  renderer's private footprint everywhere);
- the page's screens and atlases (`gpu.ts`): how many screens are mounted and in view, how many
  hold a WebGL context (a canvas under `.xterm-screen` with a `webgl2` context), how many of
  those are lost, and for each texture atlas its pages and their sizes and how many contexts
  hold it. Each context uploads its own copy of every page, so the pages times the contexts is
  what the atlases cost in textures (4 bytes a pixel, mipmaps apart).

profile.md's memory section tables each scenario and build, a row a number and a column a
point, with the median and the range across runs, and lists every dump node two levels deep that
reaches 1 MB in the GPU process or 5 MB in the renderer, by path: which of them carry the
textures depends on the GPU and the driver, so the report shows them all rather than naming
one. profile.json has every sample whole, under each run's `memory`, and each phase's page
screens under its `gl`.

## The output

In the output folder:

- `profile.md`: the machine (CPU, GPU, display, window), the triggers a scenario, React's
  profiling build's overhead, then a table a scenario and build, a row a number and a column a
  phase, each cell the median and the range (min–max) across the runs, phases of runs that
  failed part way included, and the throttled phases left out, listed; then the memory section;
- `profile.json`: the same with every run's values, each phase's full breakdown, the switches and
  the agents' phases, the machine as Electron (`getGPUInfo("complete")`, `getGPUFeatureStatus()`,
  the displays, read at the end of the first run that can, as right after a launch the GPU process
  may not have come up) and the trace (Chromium's own CPU, GPU and OS) record it, the scenarios, the
  trace's categories, the comparisons, the throttled phases, the options (terminals, window,
  contexts), every run's memory samples, and `problems`;
- `traces/<scenario>-<variant>-<run>-<phase>.json.gz`: each phase's trace, of every process the
  app runs, which Chrome DevTools' Performance panel and ui.perfetto.dev open;
- `maps/<variant>/`: each build of the UI the source maps came from.

`problems` should always be empty: anything there means the sandbox leaked, a build or a split
couldn't be made, a run didn't stop cleanly, or a trace couldn't be read (one past about 512 MB,
Node's longest string, can't be). profile.json and profile.md are written again after each run,
so a run that ends the profile early leaves what the runs before it got; until the last run is
done they say they're in progress (`complete: false` in the JSON), and a profile stopped by a
signal says so, still `complete: false`.

A run of the profile starts its output folder afresh: it removes the `traces/`, `apps/` and
`maps/<variant>/` folders in it first. To keep a profile, give the next run another `--output`,
or another `--machine`.

## What the numbers are

Each phase's window runs from the page's `profile-start` mark to its `profile-end`, and every
share is of that window, except those "of busy", which are of the main thread's busy, non-idle,
time.

- **Main thread busy** is the page's renderer main thread's busy time. Each trace event's self
  time goes to a kind by its name, or by its nearest ancestor's that has one (`trace.ts` lists
  them): **scripting** (script, timers, events, animation frames, microtasks, garbage
  collection), **style and layout** (style recalculation, layout, hit tests), **paint and
  composite** (pre-paint, paint, layerize, the commit to the compositor), and **other** (the
  scheduler's own work and events no kind names; `otherNames` in the JSON lists the largest).
- **Scripting's split** comes from the V8 CPU profile in the same trace, sampled about every
  150 µs, read through the source maps of the very build that ran. React's production build
  keeps its function names, so the maps lead to them; xterm's bundle and its WebGL addon ship
  their own maps, which lead on to their sources. Each sample goes to the nearest frame of its
  stack that has a kind:
  - **React render** is React's work loop (`renderRootSync`, `workLoopSync`,
    `performUnitOfWork`, `beginWork`, `completeWork` and the like), the components it renders
    included; **React commit** is `commitRoot` and the effects it flushes (mutation, layout,
    passive), what the effects run included;
  - **stores** are the UI's stores (`core/store.ts`): their dispatch with the reducers it runs,
    their updates, the listeners they wake, and the selectors those read in
    `useSyncExternalStore`'s check of whether a snapshot changed (React's `checkIfSnapshotChanged`
    and its store subscription, which run outside render);
  - **xterm parsing** is xterm's parser, its `InputHandler`, which applies what it parses to the
    buffer, and its write buffer, with whatever they call synchronously that has no kind of its
    own: a write's callback and the listeners fired while parsing (title, line feed, cursor);
  - **xterm rendering** is the script of xterm's renderer: the DOM renderer, the service that
    schedules it, and the WebGL addon. The DOM renderer's larger cost is Blink's, in style,
    layout and paint, which those rows hold;
  - **transport** is oRPC, the wire library, the runner client and the protocol's part of it
    (its schemas) and the UI's handling of a terminal's events as they arrive (`follow.ts`),
    less what those call that has a kind, as xterm's write; decoding a message the browser does
    natively, before any script, is in other main-thread work;
  - garbage collection is V8's; the rest is other script.

  The nearest frame wins: xterm parsing inside a React effect counts as xterm parsing. Each
  part's share is its share of the sampled script, applied to scripting's traced time, so the
  parts add up to scripting; `sampled` in the JSON holds the samples' own times.

- **Script self time** splits the same samples bottom up, each by the part of the script its own
  frame is in: React (React, React DOM and the scheduler), xterm's parser, xterm's renderer, the
  rest of xterm, oRPC and the protocol, other packages, the app's own, and frames no map
  describes, among them V8's builtins (`JSON.parse`, `forEach`), whatever calls them.
- **State propagation**, each phase's and each run's, is the stores' part and React's render and
  commit together, of busy: what a change of state costs from its dispatch to its commit.
- **Store listener spans**, on React's profiling build only, are `performance.measure` spans the
  build puts around the stores' listeners through the stores' instrumentation hook,
  `countListenersWoken`, should `core/store.ts` have it (`patches.ts`). The hook arrives with
  step 1.3a: until that has landed the build measures none and the row is empty. As the hook
  tells of a listener about to run, never of one done, a span runs from the first listener
  woken to a microtask queued then, which runs at the next microtask checkpoint: once the script
  that woke them, an event's listener or a promise's continuation, is done. So it holds the
  listeners, their selectors and whatever else that script ran after them; the render they ask
  for, which React schedules as a later microtask, is outside it, though a render React had
  scheduled before the first listener ran falls inside. It is a second reading of the stores'
  listeners, beside the samples'.
- **React's tracks**, on React's profiling build only, are React's own record of its work: the
  time its scheduler tracks' render entries (interrupted and prewarming ones too) and its commit
  and remaining-effects entries cover. The profiling build costs something of its own, which
  profile.md shows as each phase's busy share and busy time a frame on both builds; once step
  1.3a has landed, that cost includes the store listener spans.
- **Main thread busy a frame** is the main thread's busy time over the page's animation frames
  in the window. A saturated main thread's busy share can't grow, as what a change costs or
  saves goes into fewer or more frames; its time a frame still moves.
- **fps** and **frames over 33 ms** are the page's animation frames, as the timing run counts
  them; **frames drawn a second** are the frames the renderer's compositor drew.
- **The other threads that draw**: the renderer's compositor thread, its raster tasks, which run
  on its pool workers (each worker's time summed, so they may pass 100%), and the GPU process's viz
  compositor and main threads, each by its busy time.
- **Switch p50 and p90**, in the switches phase, are timed as the timing run times them: from the
  press to the first frame painted with the target's screen in the page, laid out. A WebGL
  screen draws its text on a canvas, so its text is read from its terminal's buffer
  (`profileText`, `patches.ts`, in every build), and a kept screen counts as soon as it is laid
  out and painted; that read is the probe's, each frame, and costs something of its own on every
  switch.

## The triggers

profile.md's first table gives what the plan reads, each run's phases together, from the runs
that have them all, each read and none throttled (a run that failed after Grid would read as Grid
alone):

- **state propagation**, of busy, step 4.0's number: the stores and React's render and commit,
  from the production build's samples; beside it **React render + commit** by three methods: the
  production build's work-loop attribution, React's own frames bottom up (its own cost without
  the components), and React's tracks, from the profiling build's runs; and the store listener
  spans, once step 1.3a has landed;
- **transport**, of busy, for T7 (over 5%).

Grid's busy share with the DOM renderer against WebGL, which E4 read from a `webgl` variant, is
gone with that variant: it loaded a second WebGL addon over the production pool's (#223), and
the production build draws with the pool's now.
