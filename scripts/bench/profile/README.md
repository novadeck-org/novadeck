# The real-hardware profile

Step 1.7's tooling (rule 18): the packaged desktop app, Electron with the GPU on, run through the
timing run's scenario and a heavy one, with a Chromium trace of every phase, and the main
thread's time split by what it went to. Its numbers are the baseline steps 4.0 and 6.0 read, once
recorded on a named machine in performance.md, and the numbers the plan's triggers read.

```sh
pnpm bench:profile [--machine <name>] [--runs <n>] [--scenario timing|heavy]… \
  [--variant production|profiling|webgl]… [--output <folder>] \
  [--switch <chromium switch>]… [--note <text>]
```

It packages the app unpacked (`pnpm --filter @novadeck/host package`), then:

1. builds the UI again with hidden source maps (`build.ts`) and checks that every script it built
   is byte for byte the packaged one, which the maps then describe; should any differ, scripting
   isn't split and `problems` says so;
2. builds each other variant's UI (`build.ts`) and puts it in a copy of the package: React DOM's
   profiling build in place of its production one (`profiling`), or every screen drawing with
   xterm's WebGL renderer (`webgl`), a patch to the emulator library's view made in that build only
   (`patches.ts`); a run on it fails should a screen not load the renderer or lose its WebGL
   context; the copies are removed at the end;
3. for each run, the scenarios and builds taking turns, makes a sandbox as the timing run does
   (`../timing/sandbox.ts`): a throwaway home with Novadeck's plugin on in
   `.claude/settings.json`, and a PATH whose only `claude` is the fake agent; it refuses to start
   if any other folder on that PATH holds `claude`, `codex` or `agy`;
4. launches the build in it through Playwright's Electron driver, its window's content 1440×900,
   shown and in front;
5. plays the scenario (`drive.ts`): 13 terminals, Grid then Focus on agent 1, a steady window in
   each (5 s warm-up, 15 s traced), then 2 passes of 15 switches in Focus, traced as one phase.
   The timing scenario has the first 5 terminals running the fake agent, busy, and the rest
   idle shells; the heavy one has all 13 busy;
6. closes the app, reaps whatever still runs in the sandbox, checks the developer's home with
   the tripwire, removes the sandbox, and reads the run's traces.

`--machine` names the machine in the output, this computer's host name by default, and the output
folder is `.cache/bench/profile/<machine>` unless `--output` says otherwise, so a second machine's
profile sits beside the first's. `--runs` is 3 by default and every variant runs by default; a run
takes about 2 minutes and a half, so the default, 3 runs of 2 scenarios on 3 builds, takes about
45 minutes. `--switch` passes Chromium a switch, as `--switch=--foo`; `--note` is kept in the
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
  --switch=--use-angle=swiftshader --switch=--enable-unsafe-swiftshader \
  --switch=--ignore-gpu-blocklist --note "xvfb smoke"
```

checks the plumbing without touching the real display. **Its numbers are a smoke test, not the
baseline**: Xvfb has no GPU, so Chromium draws in software, and the switches give the WebGL
renderer SwiftShader's software WebGL to draw with. profile.md says so in bold whenever the
trace or Electron shows software rendering.

## The output

In the output folder:

- `profile.md`: the machine (CPU, GPU, display, window), the triggers a scenario, React's
  profiling build's overhead, then a table a scenario and build, a row a number and a column a
  phase, each cell the median and the range (min–max) across the runs, phases of runs that
  failed part way included, and the throttled phases left out, listed;
- `profile.json`: the same with every run's values, each phase's full breakdown, the switches and
  the agents' phases, the machine as Electron (`getGPUInfo("complete")`, `getGPUFeatureStatus()`,
  the displays, read at the end of the first run that can, as right after a launch the GPU process
  may not have come up) and the trace (Chromium's own CPU, GPU and OS) record it, the scenarios, the
  trace's categories, the comparisons, the throttled phases, and `problems`;
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
  - **transport** is oRPC, the wire library, the protocol's client side (its schemas) and the
    UI's handling of a terminal's events as they arrive (`follow.ts`), less what those call that
    has a kind, as xterm's write; decoding a message the browser does natively, before any
    script, is in other main-thread work;
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
  press to the first frame painted with the target's screen in the page, laid out. On the WebGL
  build, whose screens draw their text on a canvas, a screen's text is read from its buffer
  (`profileText`, `patches.ts`), so a kept screen counts as soon as it is laid out and painted;
  as that read is the probe's, each frame, the WebGL build's switch times carry a cost the
  production build's don't, and the two are best not compared.

## The triggers

profile.md's first table gives what the plan reads, each run's phases together, from the runs
that have them all, each read and none throttled (a run that failed after Grid would read as Grid
alone):

- **state propagation**, of busy, step 4.0's number: the stores and React's render and commit,
  from the production build's samples; beside it **React render + commit** by three methods: the
  production build's work-loop attribution, React's own frames bottom up (its own cost without
  the components), and React's tracks, from the profiling build's runs; and the store listener
  spans, once step 1.3a has landed;
- **transport**, of busy, for T7 (over 5%);
- **Grid's busy share** with the DOM renderer and with WebGL, and how much less, relatively,
  WebGL takes of the window and of each frame, for E4 (a cut of 20% or more in the heavy
  scenario). A main thread busy 95% or more on either build is marked saturated: its cut of the
  window reads low, as what WebGL saves goes into more frames, and the cut a frame is the one
  to read.
