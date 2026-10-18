# The timing run

The benchmark's timing run (rule 16): the UI's production build in headless Chromium against
a real runner over WebSocket, as the dev-web path wires them, with fake agents that send real
hooks and status-line telemetry. Its numbers are a trend, too noisy to gate on: it writes a
report and exits 0 whatever it measured or failed to, stopped by SIGINT, SIGTERM or SIGHUP
included. It exits 1 only when `problems` holds something, as the sandbox leaked or refused to
start: that's the boundary failing, not a number.

```sh
pnpm bench:timing [--output <file>]
```

It builds the runner, the sandbox library and what they need (turbo; the relay among them,
which needs Rust), then the libraries the UI ships (as `build:try` does), and drives Playwright's Chromium (`pnpm exec playwright install chromium`
once), then:

1. makes a sandbox (`@novadeck/sandbox`): a throwaway home holding a `.claude/settings.json`
   with Novadeck's plugin on, so the runner counts Claude Code connected, and a PATH whose only
   `claude` is the fake (`agent.ts`); it refuses to start if any other folder on that PATH holds
   `claude`, `codex` or `agy`;
2. builds the UI, a production build whatever the shell's `NODE_ENV`, with the runner's address
   and token baked in;
3. starts the runner from its build with the sandbox's environment alone, then serves the UI
   with `vite preview`;
4. drives Chromium through the scenario (`drive.ts`): 13 terminals, the first 5 running the fake
   agent and the rest idle shells; Grid, then Focus on agent 1, a steady window in each with
   every agent busy (5 s warm-up, 15 s measured); then 2 passes of 15 switches in Focus, every
   third a revisit that lands on a window Focus keeps;
5. stops it all, reaps whatever still runs in the sandbox and checks the developer's home with
   the tripwire.

The report goes to `.cache/bench/timing.json` unless `--output` says otherwise (a relative path
is the repository root's, where pnpm runs the script). On Linux it can
run with no network at all, inside the e2e suite's namespace:
`node scripts/e2e/isolated/main.ts -- pnpm bench:timing`. Linux and macOS only.

## The report

Its shape, with illustrative numbers:

```jsonc
{
  "version": 1,
  "startedAt": "…", "finishedAt": "…", "commit": "<sha>",
  "environment": { "platform": "linux", "cpus": 4, "cpu": "…", "chromium": "…", … },
  "scenario": { "terminals": 13, "agents": 5, "warmMs": 5000, "windowMs": 15000, … },
  "summary": {
    "switchP50Ms": 31.2,      // press to the first frame painted with the target's screen in the page, null if none
    "switchP90Ms": 35.0,
    "switchesTimedOut": 0,    // switches that never painted within 4 s
    "agentsHeard": 5,         // agents whose hooks the runner heard: below 5, the run measured less load
    "steady": [
      // per layout: the main thread's busy share (%), frames a second, frame gaps over
      // 33 ms and long tasks, over the window
      { "layout": "Grid", "mainThreadShare": 61.3, "fps": 44.1, "framesOver33ms": 87, "longTasks": 40 },
      { "layout": "Focus", "mainThreadShare": 22.0, "fps": 59.8, "framesOver33ms": 3, "longTasks": 2 }
    ]
  },
  "samples": { "agentPhases": ["running", …], "steady": [ … frame gaps and long tasks … ], "switches": [ { "target": 1, "ms": 30.4 }, … ] },
  "problems": [],             // processes reaped after the run, the developer's home written to
  "error": "…"                // only when the run stopped short; the summary covers what it got
}
```

`problems` should always be empty: anything there means the sandbox leaked or couldn't be made,
and the run exits 1.

- **Switch times** run from the press (its event's own time, so a press waiting behind long tasks
  counts its wait) to the first frame painted after the target's screen is in the page and laid
  out: a window still fading in counts, and a kept window, in the page but hidden, counts once
  it is shown again.
- **`mainThreadShare`** is Chromium's TaskDuration over its own clock between two readings: a
  saturated main thread reads about 100.
- **`framesOver33ms`** counts frame gaps over 33 ms: at 60 Hz a single dropped frame is one.
- On a shared machine the numbers move run to run; compare runs from the same machine.

## The sandbox's limits

The runner, and every shell it starts, get the sandbox's environment alone, and the run refuses
to start while any folder on its PATH but the fake's holds `claude`, `codex` or `agy`
(`stack.test.ts` holds both). The runner reads PATH again from a login shell as it starts, where
the system's profile can put its own folders first (macOS's `path_helper` does), and its harness
work (connecting a plugin, Codex's app server) would start programs by that PATH. This scenario
connects nothing and runs no Codex, so nothing starts by it; a scenario that does needs that PATH
checked too.
