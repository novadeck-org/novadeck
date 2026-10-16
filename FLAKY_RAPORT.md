# CI flake investigation

The opening round and 30 normal reruns are complete. This report continues
`ci-flake-hunt-2` after [PR #157](https://github.com/novadeck-org/novadeck/pull/157).
Quality passed 16/30 normal rounds, PR verification 30/30, and E2E 26/30.
The opening round and diagnostic debug attempt remain separate. Repairs began
after sampling, at the user's request; the audit evidence remains unchanged.

## Findings at a glance

The strongest product finding is **N5**: a late Claude prompt hook leaves a
completed reply marked Drafting. Its state transition is reproduced from the CI
trace. **N8** reproduces delayed popover autofocus stealing the reordered row's
focus; the original CI ordering is not recorded. **N7** identifies substantial
redaction work behind a fragile wall-clock assertion. The remaining cases include
test observation/sampling races, fixture startup failures, two Windows unit-test
timeouts without phase diagnostics, and a registry connection failure.

| Case | Finding                                               | What the investigation establishes                                       |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| N1   | Codex Windows initialize timeout                      | Intermittent fixture startup; underlying cause unknown                   |
| N2   | Answered-card fallback disappears                     | Diagnostic-only transient-state assertion race, confirmed by trace       |
| N3   | Pinned-project drag still sees menu                   | Saved event observation is stale later; exact failed ordering unresolved |
| N4   | Gist catchup sees no gist                             | Fixed sleeps race cancellation or async completion in controlled probes  |
| N5   | Completed Claude reply stays Drafting                 | Product state-machine defect confirmed by CI trace and replay            |
| N6   | macOS TUI cannot take raw mode                        | `setpgid`/TTY startup failure; ownership unresolved                      |
| N7   | Continued-screen redaction exceeds budget             | Repeated suffix scanning adds real cost; Windows excess unprofiled       |
| N8   | Reordered project loses focus                         | Delayed initial autofocus reproduces the exact failure                   |
| N9   | Windows cold workspace render times out               | Slow phase unidentified; local Linux probe passes                        |
| N10  | Both pnpm setup attempts fail                         | Registry/network infrastructure; tests never started                     |
| N11  | Escape wins all twelve samples                        | Test assumes both race outcomes; no outcome inconsistency observed       |
| N12  | Windows process-window test times out                 | Slow phase unidentified; no remount violation observed                   |
| N13  | Long-reply gist checked before its note arrives       | Same fixed-sleep fixture vulnerability as N4                             |
| N14  | Codex fork leaves delivery Drafting                   | No later binding or prompt in retained trace; cause unresolved           |
| N15  | Motion check counts sixteen running animations        | Animation identities and clocks missing; cause unresolved                |
| N16  | Windows toolchain setup fails inside error formatting | Original error hidden; tests never started                               |

Historical H1–H7 below retain earlier evidence, corrected claims, reproductions
and remaining gaps. They are separate from this sample's observations. No product
or test fixes were made during sampling. The repair section below describes later changes.

## Repairs after sampling

The original run ledger and investigations describe the sampled code. These later
repairs address the mechanisms established by that evidence; local validation does
not establish a new cross-platform flake rate.

| Cases   | Change                                                                                                                                                                                                                                            | Boundary of the claim                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N5      | Preserve late-prompt bookkeeping doubt through completion; two empty input-box reads can then settle delivery. New typing, queued prompts and changed epochs invalidate recovery.                                                                 | Replays the recorded Claude transition and checks manager-driven recovery. Does not expand prompt attribution to the person.                                                                   |
| N7      | Scan assignment/JSON/YAML field names before parsing values, avoiding repeated long-value matches for ordinary fields.                                                                                                                            | Retains nested-secret coverage and the existing time budget. Continued-row suffix work still exists; no Windows performance profile was available.                                             |
| N8      | Deferred Popover autofocus preserves focus already inside the content.                                                                                                                                                                            | Regression deliberately runs Ark's initial-focus callback after project reorder. Original macOS ordering was not recorded.                                                                     |
| H5      | Keep the saved plan anchor through later resize and CodeMirror geometry updates, sleeping between changes; reader input or an explicit jump ends restoration.                                                                                     | Covers the demonstrated finite-window limitation with unit and actual-editor regression checks. Historical calm Focus-return attribution remains unknown.                                      |
| N3      | Hold the native drag pointer down while waiting for committed menu closure, pin dragging and drop affordances; then release.                                                                                                                      | Replaces a stale capture-event snapshot without dropping the in-progress drag assertions.                                                                                                      |
| N2      | Control the demo answer and settlement timers while inspecting the transient answered card and its focus.                                                                                                                                         | Exercises both the intermediate state and its eventual removal.                                                                                                                                |
| N4, N13 | Wait for actual note/gist milestones, including the initial skipped job before toggling usability.                                                                                                                                                | Keeps real transcript reads; no production recovery failure was demonstrated.                                                                                                                  |
| H1      | Wait for captured worklet audio before releasing a dictation hold; deliver a quick tap with a fixed gesture clock through the key router.                                                                                                         | Repairs fixture timing assumptions. Does not change the short-clip policy or identify the historical failure's exact ordering.                                                                 |
| N11     | Wait for the harness's interruption screen before releasing a key-first reply, and for a completed reply past the verdict window before the reply-first key. Also exercise a simultaneous live race whose screen determines the expected outcome. | Both outcomes remain required at controlled boundaries; the runner's provisional outcome is not treated as TUI readiness. No finite random sample is required to contain a reply-winning race. |
| H6      | Read the actual input box, including dim placeholders, rather than echoed history/random sandbox names; strip native, slash and JSON-escaped sandbox paths; scope Claude's clear hint to its footer.                                              | Tightens misleading assertions and footer detection.                                                                                                                                           |
| H7, N10 | Delay the existing setup retry by 180 seconds; give release and Dependabot jobs the same bounded retry.                                                                                                                                           | Infrastructure mitigation only. Does not identify or fix the historical registry outage or N16's hidden original error.                                                                        |

N1, H2 and H3 retain their original deadlines and gain app-server or paste-read
diagnostics. N6 captures stand-in TUI job-control state on startup failure. N9 and
N12 capture render phases, CPU, memory, event-loop delay and GC on failure, without
raising their deadlines. N15 retains its animation assertion and records the
animation targets and timing state if it fails again.

N14 remains unresolved: the retained fork trace records a draft and the fork
command, but no subsequent binding or prompt hook before timeout. An empty final
input box does not establish that the late-prompt repair applies. H3's late prompt
restoration and H4's immediate-stop gap also remain unresolved. No additional
production change is justified by their current evidence.

### Repair validation

On Linux with Node 26.9.0, after the repair corrections and integration with
main `014cce84`:

- Runner: **2,957 passed**, 35 deliberately skipped; UI unit/browser/motion:
  **2,817 passed**, 3 skipped; compiled desktop host: **485 passed**.
- Targeted live E2E: **9 passed** across pinned Claude Code 2.1.287,
  Codex 0.159.3 and Antigravity 1.2.14. These cover both Escape boundaries and
  the simultaneous race, refused command-like prompts, and held-input isolation.
- Pre-integration redaction/Codex-helper checks: **301 passed**; independent structured redaction
  comparison: **4,000 cases, zero output differences** against the sampled redactor.
  The new Unicode cap-boundary regression preserves astral-character handling.
- Formatting, lint (including relay Rust), typecheck, production build and actionlint
  passed. Independent runner and UI reviews found no retained actionable defect
  within the repaired scope; main also ran the actual browser and harness checks.

Raw validation logs, review reports and the source-content fingerprint are retained
in the task's `fix-validation/` directory outside the public repository. Earlier
failed development runs remain there as historical evidence; the validation index
identifies their successful replacements. These are local acceptance results, not
30 additional CI rounds or Windows/macOS acceptance.

The first integrated full test run also observed a failure in the older
single-move Grid undocking case: no window opened. Its helper and core drop path
are unchanged from main and the pre-integration task. Two instrumented one-move
trials, a held-pointer control and an injected renderer-delay trial all passed;
the latter disproves renderer completion alone as the cause. The ordinary full
suite passed on rerun. The failed run's activation, cancellation and actual drop
target were not captured, so this observation remains unresolved; no drag repair
is claimed. It is separate from the fixed-head 30-round sample. Evidence:
`fix-validation/merge-tests.log`, `merge-tests-after.log` and
`review-ui/drag-review.md`.

The first integrated CI run passed Quality on Linux, macOS and Windows, but
Codex Windows quirks observed a separate `/clear` timeout waiting for Ready
([job 116638795125](https://github.com/novadeck-org/novadeck/actions/runs/38797792155/job/116638795125)).
The trace ends with Drafting and a fresh empty Codex prompt, without a later
binding or prompt observation. As with N14, this does not reach N5's late-prompt
recovery. Test-only tracing now correlates raw titles, decoding, trust and
session-recognition gates, queued callbacks and replacement application.
Failure-only diagnostics retain bounded lock names and relative modification
times inside the E2E sandbox. These diagnostics do not establish or repair the
cause; production recognition and test deadlines are unchanged.

Review also reproduced a restart regression in the new settling guard: the
terminal record retained its checked epoch after a real shell exit and restart,
while messaging restarted its epochs at zero. A later doubt with the same epoch
was suppressed despite an empty box. Restart now clears that guard. The real PTY
regression fails without the reset and passes with it, recovering Ready in both
shell lifetimes. This is independent of the Windows replacement-observation gap.
After this correction, the full local runner suite passed **2,958 tests** (35
skipped), alongside runner typecheck, focused lint/format checks, both live Codex
replacement cases and the nine focused all-harness cases with tracing enabled.

## Method

Start from main commit `c9e73f1eabb6dbf5f00956138427b352b47df302`. Open a draft PR
with this report, then hold its code and report commit fixed during sampling.
Record the opening run separately, followed by **30 full reruns**. Each round
includes Quality (Linux, macOS and Windows tests plus static checks and build), PR
verification, and manually dispatched E2E against the pinned harness versions.
The E2E dispatch runs the complete matrix, including Windows quirks; a report-only
PR would otherwise skip it. Rerun whole workflows, including green jobs.
The opening round and 30 sampling reruns use normal CI logging. One already-started
Actions debug rerun (attempt 2) is recorded separately as an instrumented diagnostic
round and **excluded from the 30-rerun denominator**. Debug enables Playwright
recording for every behaviour test, including screenshots, DOM snapshots and
sources; passing traces are written and then deleted. That adds disk/RPC work under
the unchanged 20-minute Quality job limit and can perturb test timing. Recording
can help investigate a failure, but is not the ordinary CI workload being sampled.
The 30 normal reruns therefore start at attempt 3. Future targeted debug diagnostics
will also be recorded separately.

Poll every 180 seconds. Preserve each run ID, attempt number, head SHA, actual
checkout commit, job result, failed-job log and available failure artifacts before
starting the next attempt. Keep sampling independent of fixes. Update and push
the report after sampling so that a report change does not cancel or mix rounds.

A failure is an observation, not automatically a flake. Separate repeatable bugs,
intermittent test failures, environment/setup failures, cancellations and unknown
causes. A passing retry shows intermittence only when the relevant checkout is
unchanged. Correlated failures in one run are not independent observations. A
green aggregate without the expected matrix jobs does not count as a full round.
The denominator counts whole-workflow attempts, including failures during setup.
Such failures are labelled infrastructure and reduce the number of executed test
jobs; they are not counted as failed test assertions. For example, the macOS
tests in normal round 17 never started after both toolchain setup attempts failed.

Raw evidence stays in the uberepo task's `evidence-30/` folder, outside the public
repository. GitHub run/job links and sanitized diagnostic excerpts belong here.
Historical evidence remains in that task's `evidence/` folder; the old handoff is
preserved as `ci-flake-hunt.note.yml`.

## Run ledger

Sample head: `7ce4cfa75d64e160513205a94174ed88741283b2`. Completed reruns: **30 / 30**.

<!-- CI-LEDGER:START -->

| Round            | Quality                                                                                                 | PR                                                                                                      | E2E                                                                                                     | Result                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Opening          | [38644629467/1](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/1) success   | [38644629389/1](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/1) success   | [38644680657/1](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/1) failure   | E2E: Codex (Windows) (failure)                                                                 |
| Diagnostic debug | [38644629467/2](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/2) failure   | [38644629389/2](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/2) success   | [38644680657/2](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/2) success   | Quality: Test (Linux) (failure); Quality: Test (Windows) (failure); Quality: Test (failure)    |
| 1                | [38644629467/3](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/3) success   | [38644629389/3](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/3) success   | [38644680657/3](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/3) success   | All jobs passed                                                                                |
| 2                | [38644629467/4](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/4) success   | [38644629389/4](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/4) success   | [38644680657/4](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/4) success   | All jobs passed                                                                                |
| 3                | [38644629467/5](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/5) failure   | [38644629389/5](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/5) success   | [38644680657/5](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/5) success   | Quality: Test (Linux) (failure); Quality: Test (failure)                                       |
| 4                | [38644629467/6](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/6) failure   | [38644629389/6](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/6) success   | [38644680657/6](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/6) success   | Quality: Test (Linux) (failure); Quality: Test (failure)                                       |
| 5                | [38644629467/7](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/7) success   | [38644629389/7](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/7) success   | [38644680657/7](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/7) success   | All jobs passed                                                                                |
| 6                | [38644629467/8](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/8) failure   | [38644629389/8](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/8) success   | [38644680657/8](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/8) success   | Quality: Test (Linux) (failure); Quality: Test (failure)                                       |
| 7                | [38644629467/9](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/9) success   | [38644629389/9](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/9) success   | [38644680657/9](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/9) success   | All jobs passed                                                                                |
| 8                | [38644629467/10](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/10) success | [38644629389/10](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/10) success | [38644680657/10](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/10) success | All jobs passed                                                                                |
| 9                | [38644629467/11](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/11) success | [38644629389/11](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/11) success | [38644680657/11](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/11) failure | E2E: Claude Code (Windows) (failure)                                                           |
| 10               | [38644629467/12](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/12) failure | [38644629389/12](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/12) success | [38644680657/12](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/12) success | Quality: Test (macOS) (failure); Quality: Test (failure)                                       |
| 11               | [38644629467/13](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/13) failure | [38644629389/13](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/13) success | [38644680657/13](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/13) success | Quality: Test (Linux) (failure); Quality: Test (Windows) (failure); Quality: Test (failure)    |
| 12               | [38644629467/14](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/14) success | [38644629389/14](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/14) success | [38644680657/14](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/14) success | All jobs passed                                                                                |
| 13               | [38644629467/15](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/15) failure | [38644629389/15](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/15) success | [38644680657/15](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/15) success | Quality: Test (Linux) (failure); Quality: Test (macOS) (failure); Quality: Test (failure)      |
| 14               | [38644629467/16](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/16) success | [38644629389/16](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/16) success | [38644680657/16](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/16) success | All jobs passed                                                                                |
| 15               | [38644629467/17](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/17) success | [38644629389/17](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/17) success | [38644680657/17](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/17) success | All jobs passed                                                                                |
| 16               | [38644629467/18](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/18) failure | [38644629389/18](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/18) success | [38644680657/18](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/18) success | Quality: Test (Windows) (failure); Quality: Test (failure)                                     |
| 17               | [38644629467/19](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/19) failure | [38644629389/19](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/19) success | [38644680657/19](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/19) failure | Quality: Test (macOS) (failure); Quality: Test (failure); E2E: Claude Code (Windows) (failure) |
| 18               | [38644629467/20](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/20) success | [38644629389/20](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/20) success | [38644680657/20](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/20) success | All jobs passed                                                                                |
| 19               | [38644629467/21](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/21) failure | [38644629389/21](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/21) success | [38644680657/21](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/21) success | Quality: Test (Linux) (failure); Quality: Test (failure)                                       |
| 20               | [38644629467/22](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/22) failure | [38644629389/22](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/22) success | [38644680657/22](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/22) success | Quality: Test (Windows) (failure); Quality: Test (failure)                                     |
| 21               | [38644629467/23](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/23) success | [38644629389/23](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/23) success | [38644680657/23](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/23) success | All jobs passed                                                                                |
| 22               | [38644629467/24](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/24) failure | [38644629389/24](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/24) success | [38644680657/24](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/24) success | Quality: Test (Linux) (failure); Quality: Test (failure)                                       |
| 23               | [38644629467/25](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/25) success | [38644629389/25](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/25) success | [38644680657/25](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/25) failure | E2E: Codex (Windows) (failure)                                                                 |
| 24               | [38644629467/26](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/26) failure | [38644629389/26](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/26) success | [38644680657/26](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/26) success | Quality: Test (Linux) (failure); Quality: Test (failure)                                       |
| 25               | [38644629467/27](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/27) success | [38644629389/27](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/27) success | [38644680657/27](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/27) success | All jobs passed                                                                                |
| 26               | [38644629467/28](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/28) success | [38644629389/28](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/28) success | [38644680657/28](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/28) success | All jobs passed                                                                                |
| 27               | [38644629467/29](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/29) failure | [38644629389/29](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/29) success | [38644680657/29](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/29) success | Quality: Test (Linux) (failure); Quality: Test (failure)                                       |
| 28               | [38644629467/30](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/30) failure | [38644629389/30](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/30) success | [38644680657/30](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/30) success | Quality: Test (macOS) (failure); Quality: Test (failure)                                       |
| 29               | [38644629467/31](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/31) success | [38644629389/31](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/31) success | [38644680657/31](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/31) success | All jobs passed                                                                                |
| 30               | [38644629467/32](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/32) success | [38644629389/32](https://github.com/novadeck-org/novadeck/actions/runs/38644629389/attempts/32) success | [38644680657/32](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/32) failure | E2E: Codex (Windows quirks) (failure)                                                          |

<!-- CI-LEDGER:END -->

## Historical cases carried into this audit

These are observations from the task note, not new failures from this sample.
Their causes and current status are being checked against the retained evidence
and current main. Historical counts have different denominators and are not
included in the 30-rerun failure rate.

### H1: Dictation starts late or produces no transcript

- macOS Quality run [38491584016](https://github.com/novadeck-org/novadeck/actions/runs/38491584016), job 115617950482:
  `records while the shortcut is held and pastes the transcript into the terminal without sending it`
  waited 30 seconds for a transcript; the input stayed empty and the screenshot had no strip.
- Windows Quality run [38516615440](https://github.com/novadeck-org/novadeck/actions/runs/38516615440), job 115696742395:
  `keeps recording after a quick tap until the next press` never saw `Esc discard`.
- The earlier CPU-load probes passed 12/12 and 10/10; they did not establish a cause.
  Leads: capture startup still pending at release, fewer than 0.3 seconds of captured
  samples being silently discarded, or focus changes affecting a held shortcut.
  The old note's blanket claim that blur cancels the clip is incorrect for the
  current state machine: blur finishes a hold and leaves toggle mode recording.
- Diagnostic added previously: `Dictation, as it changed:` logs strip text, live
  microphone tracks, focus and visibility. Investigate retained logs and delay
  capture startup or stall the browser around release to discriminate those leads.
- Investigation: reproduced both failure shapes in Chromium on the sampled code.
  Delaying `AudioWorklet.addModule` by 2.6 seconds lets the hold test see its two-second
  timer and a live track, then lose the transcript. A live track proves microphone
  access, not a connected worklet or captured audio. `voice/capture.ts:65` awaits the
  worklet; `voice/dictation.ts:210` finishes the current capture, and :237 silently
  discards fewer than 0.3 seconds of appended samples. Controller probes also reproduce
  a ready capture with too few samples being discarded without a notice.
- A second Chromium probe blocks the main thread for 350 ms after dictation handles
  keydown. The intended quick tap becomes a hold: `voice/dictation-state.ts:113` uses
  a strict 300 ms threshold. Release stops it before enough audio is captured; the
  existing `Esc discard` assertion fails with empty status regions. Focus stays true.
- Baseline: the two original dictation tests passed locally (2/2). Injected-delay and
  injected-stall tests failed at the historical assertions. Evidence:
  `evidence-30/ui-investigation/browser-probe.log`, `quicktap-capture-browser-probe.log`,
  `controller-probe.jsonl`, and `baseline-browser.log`.
- Status: demonstrated product behavior and test timing vulnerability; **historical
  attribution remains unknown**. The retained failures predate the watcher. On recurrence,
  record keydown/keyup and controller times, capture request/resolve times, audio-context
  state, appended sample count, and finish reason. The 50 ms strip watcher alone can miss
  an entire short recording. CPU-load correlation cannot supply the missing timing.

### H2: Codex long-prompt paste on Windows

- E2E run [38500197338](https://github.com/novadeck-org/novadeck/actions/runs/38500197338), job 115675831367:
  `gives its agent a long prompt that its box may show as a placeholder` failed
  with `PROMPT_FAILED: The prompt did not show in the agent's input box`.
- The paste had a five-second landing budget. The job took 913 seconds rather
  than its usual 500–600; load is a lead, not proof. The retained trace had no
  screen for this refusal. A diagnostic was added to record paste duration and
  the final box read. Check whether the paste never appeared or the read ran late.
- Investigation: the retained trace has bracketed paste at +1874 ms and teardown
  at +6879 ms, with no Enter or model call and no box read. A probe of the actual
  `runner/terminals/prompts.ts:382` landing method accepts two matching reads at
  roughly 50/100 ms, rejects a persistently empty box, and rejects a first matching
  read arriving after a shortened 200 ms deadline. Both a never-visible paste and
  late rendering can therefore yield the refusal. Evidence:
  `evidence-30/runner-investigation/mechanisms.json`.
- Status: historical cause unknown. Read the new paste diagnostic at
  `application/runner/src/e2e/trace.ts:380` on recurrence. If its latest read does
  not distinguish the paths, retain matching-read counts/times and input-hold state.
  The 913-second job duration is a correlation, not proof of starvation.

### H3: Claude Code interruption leaves text in the box on Windows

- E2E run [38423918342](https://github.com/novadeck-org/novadeck/actions/runs/38423918342), job 115396144496, on PR #164;
  also observed on the Dependabot hono PR. The old note estimates about 2/40.
- `interrupts a running turn, which ends without a normal stop, and takes the next prompt`
  failed with `CONFLICT: input box holds text already` after interruption returned.
- Leads: Claude restored the interrupted prompt after the runner accepted an empty
  box, or the runner read a stale screen. The earlier double-Escape/Rewind-picker
  fix might share a cause, but the note does not show that. Added traces capture
  box reads, Escape, settling and the refusal screen.
- Investigation: controlled probes of the actual `Interrupts` reproduce two paths.
  With the default 500 ms calm window, interrupt returns around +550 ms; restoring
  the old prompt at +800 ms leaves it for the next send to reject. A stale pre-Escape
  screen already containing the submitted text also skips clearing. In both cases,
  `Prompts.emptied` produces the exact historical draft conflict. Evidence:
  `evidence-30/runner-investigation/mechanisms.json`.
- The separate retained Rewind trace proves a different failure: another Escape pair
  was sent while the first pair was half-consumed; one key cleared and the next opened
  Rewind. That case is fixed in #157 and must not be assumed to explain this draft conflict.
- Status: candidate mechanisms demonstrated, historical attribution unknown. On
  recurrence, compare the first box, settled box, clear keys and next-send refusal
  screen. Empty-before/empty-settle then old text supports late restoration;
  old text in the first read followed by no clearing supports stale output. If
  still ambiguous, capture TUI output and screen-drain times around Escape.

### H4: Very early Codex Stop acts as idle Escape

- A raw-Escape test observed a Stop within roughly 10 milliseconds of prompt
  submission being read as idle Escape, followed by `esc again to edit previous message`.
- The hook can report working before Codex draws its running state. The old test
  now waits for the running screen. An agent or programmatic client can still
  reach this gap; the note names other scenarios that interrupt immediately after
  the hook but have not failed. The escape-race test may pass by calling it a won reply.
- Investigation: the retained macOS trace records submission at +1880 ms, raw
  Escape at +1891 ms, first model call at +1894 ms and normal Stop at +3166 ms:
  the raw key did not stop that turn. The hook-only gate remains unchanged.
- Current Linux Codex 0.159.3 probes did **not** reproduce it: three Stops 0–1 ms
  after hook-working and one running-screen control all ended interrupted.
  Their screens already showed `Working`. These four cases do not prove macOS
  or Windows safe. Evidence: `evidence-30/runner-investigation/codex-early-1.json`
  through `codex-early-3.json`, `codex-running-control.json`, and `live-traces/`.
- Status: historical raw-key race observed; equivalent programmatic exposure is
  a remaining hypothesis. On a reproducing OS, compare hook-working against
  running-screen readiness through the roughly 11 ms historical key window,
  recording hook, key, screen and final-outcome times.

### H5: Plan-scroll restore ends before layout settles

- PR #157 extended restoration until time, frame and unchanged-layout conditions
  were met. The old note records a residual risk when a late zoom, fit or font load
  happens after restoration stops and a follower saves the wrong place.
- A calm macOS variant found the pane at the top in round 1 at `a689fc54`;
  leaking busy-test stalls were suspected but unproven. Those stalls now stop after each test.
- The old busy-load reproduction used 220 ms main-thread stalls every 260 ms;
  general CPU hogs had not reproduced the failure. A persistent layout listener
  was proposed, but not tested or shipped.
- Investigation: the retained calm macOS failure occurs at the **first Focus return**,
  before that test switches to Canvas. It must be tracked separately from the busy
  Canvas measurement failure fixed in #157. Current specs clear all starvation intervals
  after each test, but the old logs do not prove leaked stalls caused this failure.
- A model probe of the actual `restoreScroll` function demonstrates the residual
  limitation: a modeled line moving 100 pixels at +100 ms is corrected; moving at
  +300 ms after restoration finishes leaves the 100-pixel error and no scheduled
  frames. This proves the finite restore window's limitation, **not** a CodeMirror
  reproduction or the cause of the historical Focus failure. Source:
  `terminals/companion/plan-editor/scroll.ts:185`; its observer at :198 disconnects
  once a hidden pane becomes visible. `PlanEditor.tsx:130` then follows scrolling and
  :134 saves the measured anchor. Probe: `evidence-30/ui-investigation/scroll-probe.jsonl`.
- Status: residual mechanism demonstrated; calm Focus-return cause unknown. On recurrence,
  capture the saved anchor before mount and after following, restore stop reason/frame
  count, scroll dimensions, measured line position, content height, zoom and test identity.
  Current main has no voice or scroll implementation changes after #157.

### H6: Assertions that can pass for the wrong reason

The note records these as weak checks, not confirmed flaky failures:

- `answers.e2e.ts` searches the whole screen for `qq`, which can appear in the random sandbox suffix.
- Windows sandbox-root stripping may miss forward-slash or JSON-escaped forms,
  allowing random `zz` in tool results to satisfy a screen assertion.
- `chat.e2e.ts` checks that `/clear` is absent from a whole screen.
- Claude's `clearPending` searches for `Esc again to clear` anywhere on screen.
- The effect of one Escape on a just-cleared Claude box was not empirically checked.
- The rewind guard includes `Nothing to rewind to yet`.

Status: weaknesses confirmed in current source; no additional historical failure is attributed to them.

Investigation confirms these weaknesses with current source and controlled inputs:
`qq` in a sandbox header satisfies the whole-screen assertion with an empty box;
native-root replacement misses forward-slash and JSON-escaped Windows paths;
`Esc again to clear` in conversation history changes `clearPending` even when the
footer has no such hint. The `/clear` absence check can fail on earlier echoed text.
These are coverage/selector defects; no new CI failure is claimed from them.
Evidence: `evidence-30/runner-investigation/mechanisms.json`.

The previously unprobed single-Escape claim was checked on Linux Claude Code
2.1.287: Escape at 100 ms and 600 ms after the box was cleared opened no Rewind.
Windows and an Escape delivered while clearing remain unprobed. All six live
runner probes passed in 28.97 seconds after building the missing local relay;
the first startup attempt failed solely because that build prerequisite was absent.
Logs and full traces: `evidence-30/runner-investigation/live.log` and `live-traces/`.

### H7: pnpm setup registry timeout

A Windows Mixed job timed out fetching `@pnpm/win-x64` from npm. PR #157 added
a second setup attempt in PR, Quality and E2E. The old note says release and
Dependabot automerge still had one attempt. Record both recovered first-attempt
failures and terminal setup failures separately from test flakes.

## Previously fixed cases

The task preserved these fixes from merged PR #157 for context. They are not
claimed to have recurred in this sample:

- Antigravity's late session binding at `/clear` on Windows.
- Claude interruption retry sending a second Esc-Esc and opening Rewind on Windows.
- Plan-scroll restoration finishing too early on a busy page (with the H5 residual caveat).
- E2E leftover checks reporting an exited `agy.exe`.
- Test races around Codex Escape before its running screen, delivery state reads,
  `settleBox` on Windows, and random sandbox `zz` matching assertions.
- The pnpm setup retry described in H7.

## New findings and investigations

### N1: Codex app-server initialization times out on Windows

- Opening E2E run [38644680657, attempt 1](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/attempts/1),
  [Codex Windows job 116128663617](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/job/116128663617).
  `chat.e2e.ts > Codex > gives its agent prompts back to back, awaited one by one and queued together`
  failed with `Codex's app-server didn't answer initialize in 20000 ms` at
  `application/runner/src/e2e/agents/codex.ts:303`.
- Quality and PR verification passed; the other 15 E2E matrix jobs passed. This
  failure precedes the scenario's prompt-queue assertions and is distinct from H2.
- Its trace reports event-loop stalls of 3976 ms at +4603, 555 ms at +5664 and
  980 ms at +28190, followed by `No model calls yet.` It has no app-server
  request/response/process-output events, so it cannot identify why initialization
  missed its deadline. The stalls establish scheduling delays, not the startup cause.
- Evidence: `evidence-30/round-00/e2e/logs.zip`, `run.json`,
  `artifact-11932013570.zip` (artifact `e2e-traces-Codex-Windows`). All 16 E2E
  checkouts were individually verified at sample head
  `7ce4cfa75d64e160513205a94174ed88741283b2`; Quality and PR checked out the
  original merge commit `7fb4fd1452120d8ef4898aea1f89aa542fde9c80`.
- Status: confirmed intermittent fixture startup failure, root cause unknown.
  The same Windows case passed in instrumented attempt 2 and normal round 1
  (attempt 3), with the same code checkout. Its opening failure remains outside
  the 30-normal-rerun rate; ordinary-sample recurrence is still being measured.
  The job had 101 passing tests and this one failure; its suite took 965.39 seconds.
- Investigation: `fixture.ts:138` calls Codex connection before entering the test
  body. Connection starts `trustHooks`, whose helper launches `codex app-server`
  and sends `initialize` before terminal startup. The missing response says nothing
  about the scenario's queue behavior. The unchanged helper ignores stderr,
  swallows stdin errors and discards non-JSON or unmatched stdout. Only a complete
  line with the matching numeric request id satisfies it.
- Ten controlled probes of the actual helper distinguish valid LF/CRLF responses,
  protocol error, spawn error and child-close error. Silent startup, stderr-only
  startup failure, stdin EPIPE, a response without a newline and a string-id
  response all collapse into the same generic timeout. Those injected examples
  demonstrate a diagnostic gap; none is established as the Windows cause.
  Evidence: `evidence-30/initialize-investigation/helper-probe.json` and
  `opening-codex-initialize.md`. The live historical Linux fixtures initialized
  successfully, which does not exclude a Windows startup issue.
- On recurrence, retain bounded, sanitized spawn/request/write/first-output/response/
  exit/close times, stdin error, output counts and tail, buffered fragment, stderr
  tail and timeout-time process state. Windows teardown invokes `taskkill` without
  awaiting completion; record its outcome too. No leak was observed here. These
  signals can distinguish startup-budget delay from transport, framing or CLI
  startup failure. The preserved trace alone cannot do so.

### N2: Answered-request visibility assertions race the demo's settling timer

- Instrumented diagnostic Quality
  [38644629467, attempt 2](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/attempts/2),
  [Linux job 116138656795](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116138656795)
  and [Windows job 116138656824](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116138656824).
  `chat.spec.tsx > A request that waits on the person > once answered > shows it as answered, without its buttons, until the agent reports it settled`
  timed out after 30 seconds waiting for `expect.element().toBeVisible()`.
- The exact failed check is `application/ui/src/specs/chat.spec.tsx:253`, the
  `Answer in terminal` fallback button, after two earlier assertions. The demo
  expires the answered state after 500 ms. Both trace reconstructions show the
  answered card **with its fallback button present**, then gone during awaited
  trace-marker operations before the third assertion. Linux: present at trace
  time 347760 ms, gone at 348055 ms. Windows: present at 412355 ms, gone at
  412984 ms. The final trace shows the completed reply.
- Classification: a sequential assertion race against a transient demo state,
  exposed by recording overhead. It is not evidence that the product omitted the
  fallback button. The two OS failures share the same mechanism and diagnostic
  workload; do not treat them as independent ordinary-sample observations.
- Evidence: `evidence-30/diagnostic-debug/quality/` retains both UI failure
  artifacts and full logs; the trace reconstruction is under
  `evidence-30/chat-answered-investigation/`. Ordinary recurrence is measured in
  the separate 30 normal rounds. Investigation is complete from the two retained
  traces: extending the test's 30-second timeout would not restore a state that
  already settled. A future test change needs to control settlement or observe
  the answered state before its transient window expires.

### N3: Pinned-project drag records an open menu in its saved event sample

- Normal rounds 3, 4, 11, 13, 19, 24 and 27, Linux Quality, failed the same
  `agents.spec.tsx` check: `says where to drop until the drag is let go, after the menu has closed`.
  It expected `{ menu: false, hint: true, target: true }` and captured
  `{ menu: true, hint: true, target: true }`. First
  [job 116162865373](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116162865373);
  subsequent jobs: 116170529407, 116219239288, 116232509567, 116273375742.
- The retained screenshots for the first four occurrences are byte-identical and
  show the menu closed and `docs-site` pinned successfully. The failing value is
  an earlier capture-phase pointer-move observation, not that final screenshot.
  A stale event sample is being discriminated from a persistent menu defect.
- Source shows a non-atomic handoff: pin drag state is published synchronously,
  while ending the original drag and closing the menu occur through a separate
  transition. A local observation probe saw the pin dragging with its menu open
  for about 81 ms normally and 679 ms under injected main-thread stalls, then
  both probes recorded the expected final state. Four repeats of the original
  selected test passed locally. **The exact failed CI sample was not reproduced.**
- Status: repeated normal-CI failure; a stale last-pointer-event observation is
  strongly supported, while exact CI ordering and acceptable product handoff
  latency remain unresolved. Record capture/bubble pointer events, handoff,
  original drag end, React menu commit and pointer release together. A fixed
  number of moves does not establish a post-close observation while still held.
  Evidence:
  `evidence-30/round-03/quality/` and the corresponding later round folders;
  `evidence-30/new-ui-investigation/` contains the comparison and timing probes.

### N4: Gist catch-up test outruns asynchronous transcript reads

- Normal round 6, Linux Quality
  [job 116185576288](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116185576288),
  `terminals/murmur.test.ts:2064`: `asks for the gist again when murmur becomes usable, after a job that did not run`
  expected `["Did it"]`, received `[]` after about 308 ms.
- The fixture uses two blind 150 ms real sleeps around a 50 ms debounce and
  asynchronous transcript reads. Its fake describer returns `undefined` on call
  1 and `Did it` only on call 2. Neither sleep establishes which call completed.
- Two probes using the actual production classes reproduce the assertion. A
  200 ms delay in the first build lets recovery cancel that build before it reaches
  the fake; the recovery is then call 1 and intentionally returns nothing. A
  delay in the second build instead makes the final assertion run before the gist
  arrives at about 402 ms. Waiting for the first fake note before toggling usability
  makes the first delayed case pass.
- Classification: fixture synchronization weakness demonstrated; the exact CI
  interleaving is unknown because it recorded neither build timing nor call counts.
  No persistent product recovery failure was established. Synchronize on actual
  note/gist milestones; a short extension of only the final sleep cannot repair
  the first variant, whose normal automatic retry is a minute later.
- Evidence: `evidence-30/new-murmur-investigation/gist-probe.log` and
  `round-06-failure-excerpt.log`. The original focused test passed locally.

### N5: Late Claude prompt hook leaves a completed turn falsely Drafting

- Normal round 9, Windows E2E
  [job 116205754888](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/job/116205754888),
  `chat.e2e.ts > Claude Code > gives its agent emoji sequences and CJK, then the next prompt`
  timed out waiting 30 seconds for Settled. The agent was idle, its reply complete,
  and its input box visibly empty, but delivery remained Drafting.
- **Product state-machine bug, confirmed by trace and exact event replay.** Paste
  at +3475 ms sets the remembered box non-empty; Enter is +3635 ms. The prompt hook
  fires at +5979 ms, **2344 ms after Enter**, exceeding
  `application/runner/src/messaging/delivery.ts:152`'s 2000 ms submission window.
  Handling it at +6447 ms therefore omits person attribution and preserves the
  remembered non-empty box. Completed Stop at +7136 ms returns delivery to Drafting.
- The late-hook path leaves `box.doubted = false`; both `Terminals.settleBox`
  (`manager.ts:3942`) and matching-epoch `emptied` events (`delivery.ts:682`) require
  doubt to recover. The actual transition replay reproduces Drafting and no
  ringable time. Moving only the hook's firing time to 1900 ms after Enter produces
  Settled and a ringable time. No emoji parser error is needed.
- A false draft can block message ringing despite an idle agent and empty box;
  that impact follows from the state machine, while a pending-message failure was
  not directly exercised here. The lower-level reason the hook fired late remains
  unrecorded. A future repair must preserve real drafts and queued prompts while
  allowing this bookkeeping doubt to be checked against the screen; simply
  widening attribution changes which generated turns count as the person's.
- Evidence: `evidence-30/new-claude-investigation/round-09-trace.txt`,
  `round-09-replay.json`, `replay.mts`, and `replay.log`. The replay assertions passed.

### N6: macOS stand-in TUI dies during job-control initialization

- Normal round 10, macOS Quality
  [job 116212475939](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116212475939),
  `shell/integration.test.ts > keeps Antigravity Drafting when a turn after the Enter brought no typed input`
  never reached `agy ready`. Bash printed `child setpgid ... Operation not permitted`,
  then the Node stand-in failed with an unhandled `setRawMode EIO` and returned to `$`.
- The crash occurs at fixture raw-mode initialization
  (`integration.test.ts:4251`), before readiness, `ringing`'s return at :4440,
  or the drafting scenario at :5525. It is not an observed drafting-state regression.
  A longer readiness wait cannot revive the exited process.
- Classification: intermittent integration startup/job-control failure; ownership
  between fixture, production PTY boundary and dependency remains unresolved.
  The test uses real Bash and production node-pty; Darwin uses a different native
  spawn/session path from Linux. The exact focused test passed once on Linux
  (1 passed, 151 skipped, 8.52 seconds), which cannot establish macOS correctness.
- On a Darwin reproduction, record PID/PPID/PGID/SID, terminal foreground group,
  tty path and stdin TTY state before raw mode and on error, plus shell/PTY exit
  and signal times. The log shows both OS errors in order, but lacks the state
  needed to prove their full causal chain. Evidence:
  `evidence-30/new-macos-investigation/` and `new-macos-findings.md`.

### N7: Continued-assignment redaction exceeds a wall-time performance guard

- Normal round 11, Windows Quality
  [job 116219239459](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116219239459),
  `murmur/redact.test.ts:856`: the 60-by-400 continued screen of `a=b` without spaces
  took **2475.36 ms**, exceeding `< 2000 ms`. Four other timing examples passed.
- The work is substantial: `redact.ts:484` scans every suffix of a continued-row
  group as well as each row. A 24,000-character input supplies 756,000 characters
  to `mark`; fixed-width suffix work grows quadratically with row count. The
  assignment rule repeatedly matches up to 1024 value characters before rejecting
  harmless names and restarting within the value.
- A bounded instrumented pass counted 251,370 overlapping assignment matches and
  about 241 million matched characters. Uninstrumented Linux controls took
  757–1121 ms at 60 continued rows versus 16.9 ms without continuation; 90 continued
  rows took 2012–2280 ms. These local Node 26.9.0 numbers are not Windows benchmarks.
- Classification: wall-time budget sensitivity with demonstrated algorithmic
  cost; no output corruption or unbounded regex match was observed. The CI log
  cannot distinguish CPU contention, GC and per-rule costs. Production redaction
  runs in a worker with a 1500 ms deadline, so costly valid digests can be rejected
  as late; no real dropped digest was observed in this incident or probe.
- Profile the Windows case and reduce redundant scanning while preserving nested
  secret detection. Raising only the test limit does not address the smaller
  worker deadline. Evidence: `evidence-30/new-murmur-investigation/redaction-probe.log`
  and `round-11-failure-excerpt.log`. Five original focused timing tests passed locally.

### N8: macOS project reordering leaves keyboard focus on another project

- Normal round 13, macOS Quality
  [job 116232509677](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116232509677),
  `sessions.spec.tsx > moves the focused project with Alt and the arrows, keeping the focus on it`
  failed its focus assertion: `api-service` held focus after `storefront` was reordered.
- The installed Ark popover's default initial-focus action schedules an animation
  frame, then recomputes the first focusable child. Project reordering separately
  restores focus to the moved project's button. A controlled browser probe delays
  only the initial-focus callback by 350 ms: storefront is restored at +682 ms,
  then the callback at +925 ms focuses the newly first `api-service`. Yielding
  before the assertion reproduces the exact wrong focus. The no-delay control
  preserves storefront focus.
- Classification: competing focus ownership demonstrated, a strong candidate for
  this CI failure; its original call ordering was not retained. It can also steal
  a user's focus if interaction precedes deferred initial autofocus. Respect
  deliberate focus changes; asserting earlier can conceal the race. On recurrence,
  record initial-focus scheduling/execution, row focus calls, DOM reorder commits
  and native `focusin` events. The scheduling claim comes from installed
  `@zag-js/popover` 1.45.0; the current official
  [Ark React Popover API](https://ark-ui.com/react/docs/components/popover)
  confirms default autofocus and the initial-focus control.
- Evidence: `evidence-30/round-13/quality/` and `new-ui-investigation/`.

### N9: First Windows render-scope test exceeds its cold-start budget

- Normal round 16, Windows Quality
  [job 116252083947](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116252083947),
  unit `app/render-scope.test.ts > when the page first renders > renders every section`
  timed out at 30 seconds while awaiting `open()`.
- It is the first cold render; the log records 32.684 seconds for that case and
  subsequent cases completing in roughly 3.1–4.7 seconds. There is no phase timing
  to identify import, render, task-drain or scheduling delays.
- At the same fixed source, a previous Windows round passed its first render at
  22.706 seconds; most observed first cases took 1.6–6.5 seconds. `open()` performs
  synchronous StrictMode rendering and async `act`, imports and provider handover.
  A bounded Linux phase probe recorded render completion at 255.7 ms, imports and
  handover at 265.0 ms, and `act` completion at 479.8 ms, with all expected sections.
  It did not reproduce the Windows timeout.
- Status: cause unresolved after phase inspection and a local probe. Neither the
  declaration-line stack nor the cold/warm timing identifies a slow render,
  delayed import/effect/`act`, or scheduling delay. Capture each phase and the
  render-counter snapshot, plus event-loop delay and CPU/memory. Do not attribute
  it to load or fix it by raising the timeout without that evidence.
  Evidence: `evidence-30/round-16/quality/`,
  `new-ui-investigation/windows-render-durations.json` and phase observations.

### N10: Both macOS toolchain setup attempts fail registry connectivity

- Normal round 17, macOS Quality
  [job 116258727777](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116258727777).
  This is a recurrence of the H7 failure class despite the existing retry.
- The first pnpm 11.22.0 download aborted after about 70 seconds with TLS
  `read ETIMEDOUT`. The retry failed connecting to `registry.npmjs.org/pnpm` with
  `UND_ERR_CONNECT_TIMEOUT` after 10 seconds. **The macOS test command was skipped.**
- Classification: setup/network infrastructure, not a failing test assertion.
  `continue-on-error` makes the first step appear successful in Jobs API metadata;
  its log and the conditional retry's execution establish its actual failure.
  Count this attempt separately from executed macOS test jobs.
- The failure layer is clear; the historical runner, network route and registry
  service cannot be distinguished from these logs. A new request from this Linux
  machine would not establish that old macOS connection. Evidence:
  `evidence-30/new-macos-investigation/round-17-macos-job.json` and the two setup logs.

### N11: Fixed Escape-race delays fail to produce a reply-winning sample

- Normal round 17, Windows E2E
  [job 116258845966](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/job/116258845966),
  `escape-race.e2e.ts:117` failed its final `lost > 0` assertion: all 12 attempts
  reported that the key won. Leads of 20, 200 and 500 ms were each used four times.
- Every preceding per-attempt idle/outcome/no-false-completion check passed.
  All 12 final outcomes were interrupted, including two with Stop hooks firing
  95 and 87 ms after Escape. No product outcome inconsistency was found.
- Classification: test sampling flake. Three fixed delays cannot guarantee both
  sides of a live scheduling race within a finite sample. The trace's observed
  model-call-to-key intervals match the requested leads, but are not exact
  reply-release latencies. It does not retain every final screen.
- Keep release/flush time, key time, final screen, verdict and outcome, and find a
  bounded observed completion window rather than assuming fixed leads produce
  both outcomes. Increasing the repetition count alone preserves this dependency.
  Evidence: `evidence-30/new-claude-investigation/round-17-attempts.json` and trace.

### N12: Windows process-window unit test exceeds its 20-second deadline

- Normal round 20, Windows Quality
  [job 116280776922](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116280776922),
  `app/WorkspaceTerminal.test.ts > process windows > when the foreground process changes > presents Claude and Codex in the same window and returns to the terminal without remounting the surface`
  timed out after 20 seconds. The declaration-line stack points to :151, whose
  first awaited operation is `open(second)` at :152.
- The log does not identify which operation consumed the deadline or report a
  failed remount-count assertion. This is a distinct test from N9; similar timeout
  symptoms do not establish a shared cause.
- The case took 21.394 seconds; it had already passed at 18.840 seconds in round 16. In those same jobs the separate render-scope case took 32.684 seconds
  (failed round 16) and 29.805 seconds (passed round 20). This correlates slow
  rounds without establishing a shared cause between their different fixtures.
- A bounded external Linux phase probe passed every original assertion in about
  146 ms. The Windows log has no timing around startup, later process rerenders,
  or eleven style-query checks. The declaration-level stack does **not** prove
  that `open()` was the stalled operation.
- Status: cause unresolved after source, duration and phase-probe investigation.
  Capture those phases separately, along with test-worker scheduling and CPU/
  memory/GC data. No remount-count violation was observed. Evidence:
  `evidence-30/workspace-terminal-timeout.md`, `workspace-terminal-investigation/`,
  `round-20-quality-failed.log` and the round's full archived workflow logs.

### N13: Long-reply gist assertion runs before the note arrives

- Normal round 22, Linux Quality [job 116300052297](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116300052297),
  `murmur.test.ts > tells a failed turn, and cuts a long reply to its head and tail`
  accessed `describer.notes[0].digest` before there was a note.
- The case waits through the same fixed `real()` delay as N4, then reads the
  asynchronous result. Retained evidence: `evidence-30/round-22/quality/logs.zip`.

### N14: Codex fork leaves delivery Drafting with an empty box

- Normal round 23, Codex Windows [job 116309123213](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/job/116309123213),
  `forks.e2e.ts > forks in place: what waited for the parent is gone, and the fork is rung for what comes next`
  waited 30 seconds for the next message. Delivery changed from Settled to Drafting;
  the agent was idle and the final screen showed its empty input placeholder.
- This is a distinct observation from N5. The retained fork trace is being checked
  for session, box and ring ordering before attributing it to the same mechanism.
  Evidence: `evidence-30/round-23/e2e/`.

### N15: Motion check still counts sixteen animations

- Normal round 28, macOS Quality [job 116360579122](https://github.com/novadeck-org/novadeck/actions/runs/38644629467/job/116360579122),
  `motion.spec.tsx > settles on the last requested view and remains interactive`
  expected no running finite animations but counted sixteen.
- The retained log identifies the count, not the animations, their targets or
  timing states. It cannot distinguish a stuck view transition from animations
  started by other parts of the page. Evidence: `evidence-30/round-28/quality/`.

### N16: Windows toolchain setup exits inside Node's error formatter

- Normal round 30, Codex Windows quirks [job 116392831497](https://github.com/novadeck-org/novadeck/actions/runs/38644680657/job/116392831497),
  both toolchain setup attempts exited while downloading pnpm 11.22.0, before
  the E2E command ran. Node 24.19.0 reported `Expecting Unicode escape sequence`
  from its internal Acorn parser, called by `getFirstExpression` in the error
  formatter, at the identical position on both attempts.
- This is a setup failure, not a Codex test failure. The formatter stack does not
  identify the original error it was formatting. No application repair or
  dependency upgrade is justified by that stack alone. Evidence:
  `evidence-30/round-30/e2e/logs.zip`.
