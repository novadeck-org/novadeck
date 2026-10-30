# Targeted flake capture

Capture the remaining Grid undocking and Antigravity Stop-boundary failures with their
original inputs and test deadlines. These probes collect evidence; passing samples do
not establish a repair.

The `Flaky capture` workflow runs when a pull request changes these diagnostic scripts,
its workflow, or the opt-in Antigravity probe/config. It checks out the exact PR head
SHA with read-only repository permissions. Grid runs on macOS and Windows; Antigravity
runs on Linux. Each job uploads its capture directory even when a test fails. The first
failed process stops that job's sequence and returns a nonzero exit status.

## Grid

With Node 26, the locked dependencies, the protocol build and Chromium installed, run
from the repository root. Use a new output directory outside the checkout:

```sh
pnpm --filter @novadeck/protocol... build
pnpm --filter @novadeck/specs exec playwright install --with-deps chromium
node scripts/flaky-capture/grid.ts --output /path/to/grid-capture --attempts 5
```

Each attempt starts a fresh Vitest process and runs the complete, unchanged
`companions.spec.tsx`: every case, including the predecessors of the ordinary
12-move and separate one-move Grid undocking cases. The existing 30-second case
deadlines and assertions are inherited from the specs package's Vitest config. There is no added delay,
repeated gesture within a case, app mock or forced scheduling condition.

`--attempts` accepts 1–5 and defaults to 5. A child-process watchdog stops infrastructure
hangs after five minutes; the total capture budget is 15 minutes, excluding dependency
setup. Either limit may end collection before five attempts and is reported as a timeout,
not a reproduced Grid failure. The workflow gives capture 17 minutes within a 25-minute
job so artifacts have time to upload.

A successful attempt requires finalized Vitest JSON reporting every case Vitest collected
from the file passed, a per-case record for each, and native release plus app-drop
observations for both Grid variants. The count comes from that collection, so the file
may gain or lose cases; empty, skipped or incomplete collection cannot report success. If
the Grid variants' titles change, update them in `grid-results.ts`.

The output contains:

- `identity.json`: actual/expected checkout SHA, Node/Vitest/Playwright versions and
  relevant source hashes. Each attempt also records its Chromium version and viewport.
- `summary.json`: requested/completed attempts and their process/capture outcomes.
- `attempt-NN/process.log`, `process.json` and `tests.json`: complete process output,
  exit/signal/timeout information and finalized test outcomes.
- `attempt-NN/case-NN.json`: native pointer/capture events and app drop state for every
  case, including successful controls. Buffers retain the last 200 events and state
  total/dropped counts explicitly. They contain coordinates, scalar pointer properties,
  non-text DOM hit/target summaries, sortable indexes and before/after drop state.
  Free-space drags also retain their planned point, view/window rectangles and viewport,
  with the view rectangle measured again at native release.
- `attempt-NN/attachments/` and `traces/`: failed screenshots and Playwright traces.
  These use visible directory names so the workflow need not upload unrelated hidden files.

A nonzero test process may be an unrelated companion assertion or an infrastructure
failure. Inspect the finalized outcomes and event sequence before calling it a Grid
reproduction. Trace collection and passive event observation can affect timing; a passing
capture does not rule out the original failure.

## Antigravity

The Linux probe requires the Antigravity version `backend/runner/src/e2e/harnesses.json`
pins (the one the E2E suite runs), protocol/relay builds and the existing loopback-only
network namespace wrapper:

```sh
export NOVADECK_E2E_AGENTS=agy
export NOVADECK_E2E_HARNESS=pinned
export NOVADECK_E2E_CACHE=/path/to/harness-cache
pnpm --filter @novadeck/protocol... --filter @novadeck/relay build
node scripts/e2e/install/main.ts
node scripts/flaky-capture/agy.ts --output /path/to/agy-capture --attempts 5
```

Each fresh process preserves the original natural order: send First quick and Second
quick; wait for Did second; send Third one and Fourth one concurrently; wait for Did
fourth; send the multiline Five prompt, then Then one immediately; wait for the original
replies and assert each original user prompt occurred once. It adds no Stop gate, held
reply, resend, settling wait or timeout increase. The original 30-second reply waits and
180-second case ceiling remain.

The launcher allows at most five attempts and stops on the first nonzero process or
non-delivered outcome. Each attempt retains its identity/binary hash, native PTY output,
input and hook/model events, final screen, delivery/binding state, transcript/history and
log. A visible `hooks.txt` copy preserves the fixture's hidden trace for artifact upload.
The probe redacts the fixture credentials and reports bounded-buffer overflow. Its
summary distinguishes a submitted follow-up that never reached the model from other
scenario failures; either result still needs investigation before choosing a repair.
When the probe stops before writing its summary, `capture.json` takes the cause from
Vitest's JSON report (`tests.json`): `failed-before-scenario` with the first error line,
`skipped`, or `no-test-report` when Vitest never reported (see `vitest.log`).

Artifacts remain for seven days. Keep successful controls and the first failure together
when archiving them, with the actual checked-out SHA rather than only the PR merge ref.
