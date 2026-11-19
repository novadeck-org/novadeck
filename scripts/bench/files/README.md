# The Files panel bench

A local benchmark of the sidebar's Files panel as works change: how long the panel keeps the
main thread busy from the first works event of a runner poll to the frame painted once it
has settled. It exists to compare `main` with changes to the works feed (batching its
publishes) and to the tree (windowing its rows), so it drives the panel only through seams
those keep: the runner adapter's works feed, and the panel's props.

```sh
pnpm bench:files [--label <name>] [--folders 300] [--files 3000] [--worktrees 20] \
  [--changed 3] [--files-per-worktree 10] [--polls 15] [--warmup 3] [--turns 0] \
  [--written 1] [--synced] [--seed 1]
```

Playwright's Chromium is needed (`pnpm exec playwright install chromium` once). Nothing is
packaged or built first: the page is built here with the web app's Vite, and workspace
packages resolve to their source. Linux and macOS; headless, as it measures the main thread's
scripting, style and layout, not compositing or the GPU, so a headless run says nothing of
paint cost.

## What it runs

`page/main.tsx` is one page: the real `FilesPanel`, wired as `SidebarSection` wires it (the
works' overlay of the project from `filesOfWorks`, the feed's `watch`, a `list` reader), over:

- a synthetic project (`scenario.ts`): `--folders` folders, four to a parent, and `--files`
  files dealt out over them, served by the panel's `list(folder)`; seeded, so two runs see the
  same tree;
- the works as the runner adapter's real `createRunnerWorks` takes them, from a fake
  `calls.watch` stream: `reset`, a `changed` for every worktree, `synced`; then, in each poll, a
  `changed` for each of `--changed` worktrees (rotating through the `--worktrees`), each
  holding its `--files-per-worktree` files, of which `--written` (default 1, rotating) get a new
  stamp and the rest keep theirs, as the runner keeps the stamp of a file that did not change
  (`--synced` ends each poll with a `synced` too). The items are handed over one to a task, as
  the app's WebSocket delivers its messages;
  Each worktree is owned by an agent with a handle, so chips show. Everything the adapter does
  with the events, batching included, shows in the numbers;
- every folder open: a seed work with a change in every folder is fed before the panel mounts,
  which opens them all (the panel opens folders with changes, once), and is removed before the
  first poll; the folders stay open.

The first `--warmup` polls are fed and not counted. With `--turns n`, after the polls the
agents' turn counter is bumped n times (the panel's `turn` prop), which has every open folder
read again; those are reported as a separate row.

## What it reports

Per poll, the figures below, as median and p95 over the `--polls`:

- **wall**: from the first event to the first frame after the last commit the poll caused. A
  poll is over once the panel has been quiet for 200 ms (every event taken, no folder read
  out, no commit or long task), longer than any delay the adapter may hold a batch for, so a
  build that publishes on a timer is measured through its commit like one that doesn't.
- **busy / script / style / layout**: the main thread's time from the first event to that
  quiet (so it includes the 200 ms wait's own background work), from Chromium's
  `Performance.getMetrics` (`TaskDuration`, `ScriptDuration`, `RecalcStyleDuration`,
  `LayoutDuration`). The summary gives the idle page's busy ms a second.
- **after busy / after commits**: the gap that follows each poll, waiting out the trails'
  timers (1.4 s) that clear the highlights, each a commit of the tree. Polls wait for it, so it
  never lands in the next one; it is reported on its own, not left out.
- **commits / react ms**: React commits (and the time React rendered them) of the whole page,
  counted by a `Profiler` in React's profiling build.
- **long tasks**: the page's tasks of 50 ms or more (count and total).
- **reads**: calls to the panel's `list`.
- **rows**: elements of the tree in the document once settled. A fact, not the work done: the
  windowing change lowers it, and the metric stays the time.

It writes `.cache/bench/files/<label>/report.json` (every sample), `summary.md` (the table),
and `panel.png`. Compare runs by label: `--label main`, `--label batching`.

To compare a branch that lacks `scripts/bench/files`, check it out detached in another
worktree and cherry-pick the bench's commit onto it (`git cherry-pick <sha>`), then run it
there with the label of the branch.

## Reading it

The numbers are a trend on one machine, and a busy machine moves them: the report records the
load average before and after. Other work on the machine (other agents' test runs) can
multiply the times, so run it on a quiet one and more than once (`--polls 30`). It never fails
on how fast something was; it fails when the page doesn't settle (60 s) or the config can't make
the scenario. The pure parts, the statistics and the synthetic project, have tests beside them.

The runner's stream, read from `backend/runner/src/works/works.ts`, sends a changed event per
changed worktree after the first replay and no `synced` in later polls, and so does the bench.
`--synced` ends each poll with one anyway, which costs the adapter one more publish.
