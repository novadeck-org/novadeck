# CI flake investigation after repairs

The rebased, repaired branch completed an opening CI round and **20 complete reruns**.
Eighteen reruns passed every job. Rerun 2 failed a Windows Grid undocking test;
rerun 12 failed a Windows cross-agent replacement test. The separate opening round
failed a Windows Codex folder-trust test. All three observations were unresolved at the end of sampling.
No source repair was made during this sample. Subsequent repairs and their limits
are recorded below.

The original plan was 30 reruns. While rerun 20 was running, the user reduced the
sample to 20. Rerun 20 finished successfully and its results were archived before
the collector stopped. Rerun 21 was not launched. The original 30-round audit and
repair validation remain in [the previous report](FLAKY_RAPORT.md).

Completed reruns: **20 / 20**.

## Repairs after sampling

The completed audit remains unchanged. The user subsequently requested repairs for
P1–P3 on this task branch.

### P1: recover an unknown trust lookup

A new real-terminal regression reproduced the lost recovery: after one Unknown
answer, an unchanged Ready title stayed Unbound even when the helper could answer
again. The repair retains no failed helper answer and checks the same observation
at most three times, one second apart. The helper's ten-second deadline is unchanged.
Each attempt and the queued readiness update check the foreground again, retaining
the same harness PID where the platform supplies it; a new title, actual key input, process,
terminal closure or delivery epoch invalidates the pending observation. Confirmed
Untrusted stops immediately. Unknown never grants readiness.

On Windows, helper cleanup now attempts to end the command wrapper and its
app-server descendants before another query starts, using bounded tree cleanup.
The adapter's prior wrapper-only kill could leave the app-server running. Transport
checks cover completion races and wrappers already exited before cleanup.

Eleven focused real-terminal tests and all 105 Codex adapter tests passed locally.
The recovery regression failed before the repair. This fixes the demonstrated
recovery gap; the original Windows helper failure is still unidentified, and three
failed attempts still leave readiness unknown. Evidence:
`evidence-postfix-30/investigations/P1/REPAIR.md` and its adjacent logs.

### P3: distinguish a reused Windows PID

A binding previously treated any live process with its recorded PID as its agent.
The repair uses the existing Windows relay tree reader when a different process or
harness reports a session, or the same PID reports a different startup session. A process start more than 50 ms after the last accepted
binding observation proves that PID now names another process. Only that proof
clears the stale binding. An old start, missing root or unreadable tree preserves
the nested-agent gate. After the asynchronous read, the terminal process, binding
and disconnection state must still be current.

The deterministic reuse regression fails with the new check disabled and passes
with it enabled. Sixteen targeted integration cases cover reuse, live and unknown
processes, clock boundaries and changes while the read waits. The real Antigravity
to Claude replacement and Antigravity nested-agent control pass on Linux. E2E
traces now retain connection admission and binding state around report handling.
Evidence: `repair-validation/p3/` and `repair-validation/p3-review/`.

This repairs a demonstrated stale-binding mechanism. The archived Windows trace
contains no process start identity at hook arrival, so PID reuse remains an
unproven explanation for P3. A later stale accepted hook can also make the timestamp
comparison inconclusive; the check then preserves the binding.

### P2: retain the next failed gesture

The undocking failure did not reproduce in 20 focused ordinary drags or two
complete 30-case companion runs, including one with Chromium's CPU slowdown set
to six times. Successful drags also reorder the taskbar, disproving that reorder
alone explains the screenshot.

The ordinary and one-move Grid cases now retain failure-only diagnostics: native
release coordinates and hit-test stack, sortable indexes, cancellation, and the
app's drop state before and after its release-point update. The gesture,
assertions and deadlines are unchanged. The source event is guarded by test mode;
the collector is confined to these specs and removes its listeners after each test.
A deliberately failed probe verified the output, and the final three focused
undocking cases passed. P2 remains unresolved. Evidence:
`fix-validation/p2-repair/REPORT.md`.

The later report-publication commit `2676eabb` also failed the ordinary Grid drag
on macOS ([job 116832231400](https://github.com/novadeck-org/novadeck/actions/runs/38857528547/job/116832231400)),
while its one-move sibling passed. This was outside the frozen sample and before
these repairs. Its final accessibility tree again shows Messages before the still
docked Plan, with no release trace; it adds a platform observation, not a cause.
The log is retained at `repair-validation/baseline-macos.log`.

### Integrated local validation

Build, typecheck, lint and formatting passed. The full runner suite passed 3,022
tests with 35 skipped; repository tests passed 196 with four skipped. The full UI
suite passed 2,881 tests with three skipped and found one forbidden type import
in the new diagnostic helper. Replacing that erased import with a local type
left runtime code unchanged; all seven architecture checks and three affected
undocking checks then passed, as did UI typecheck and scoped lint/format.
The rebuilt production UI contains no diagnostic event string.

Independent review reproduced and caught two additional cases: foreground exit
while trust was pending, and same-harness PID reuse. Both regressions now pass.
Validation logs, review boundaries and source hashes are indexed in
`repair-validation/README.md`. P2 remains unresolved.

### CI follow-up and chat fixture

At repair commit `4032c1d2`, all Quality jobs passed on Linux, macOS and Windows,
as did every Codex, Claude, Windows-quirks and mixed-agent E2E job. Antigravity
passed on Windows and macOS. These are post-sample validation results, not another
audit round or proof of the historical failure causes.

[Antigravity on Linux](https://github.com/novadeck-org/novadeck/actions/runs/38859631322/job/116838841760)
failed the back-to-back chat scenario: the final prompt was pasted just after
Stop, appeared queued, and never reached the model before the existing deadline.
The trace does not establish whether the harness or runner caused the delivery
failure. One original-scenario control and one direct-PTY input control each
passed locally, leaving that end-of-turn occurrence unresolved.

The queued-input fixture now holds each first reply until the second prompt is
visibly queued or accepted as steering. Between pairs, it requires the current
Settled state, an empty prompt and no queued input. Sequential and simultaneous
submission variants remain, and all six prompts and replies are checked. This
establishes the intended mid-turn queue precondition; it is not a production
repair for the end-of-turn delivery observation. No timeout or production input
timing changed. All three pinned harnesses passed the corrected scenario locally,
as did typecheck, lint, formatting and independent review. Evidence and controls:
`repair-validation/agy-chat/`. Subsequent CI results are recorded below.

The fixture follow-up's macOS Quality run then timed out in a trust integration
fixture. A controlled schedule reproduced its call-count assumption: the initial
Ready lookup can be superseded before it calls trust, leaving `/clear` as call one
and the test waiting for a signal it never armed. The fixture now arms its held
answer by phase, immediately before `/clear`. The same forced schedule and the
clean test pass; production code, assertions and deadlines are unchanged. The CI
log lacks phase tracing, so this is a proven fixture race compatible with that
timeout, not a proven reconstruction of its exact schedule. Evidence:
`repair-validation/ci-macos-trust-report.md`.

### Delayed prompt hooks and completed turns left Drafting

At `eb27537f`, all Quality jobs passed, including the corrected macOS trust test.
The stronger queued-chat settlement check exposed a shared Windows delivery-state
bug in Claude and Codex: both replies were complete and their prompts empty, but
Novadeck remained Drafting. Codex's existing interruption scenario also failed to
settle. Logs and raw traces are retained under `repair-validation/claude-chat/`.

In both paired-prompt traces, the second Enter arrived before the first prompt's
hook was received. That older hook unconditionally erased the newer Enter's
bookkeeping. The repair preserves a submission after the hook's firing boundary,
including later draft and cancellation state, for its own prompt hook to consume.

The interrupted Codex trace reveals a second path: a sole Enter submitted while
Unknown was conservatively marked as possibly queued. Its delayed hook fell outside
the existing person-attribution window; the stale queue flag then prevented empty
screen recovery. That specific sole submission can now become uncertain, keeping
`byPerson=false`. It settles only after completion and repeated empty/no-queue
screen reads. Real queued input, later typing, request drafts and cancellation
remain protected; neither attribution windows nor test deadlines changed.

Full build, typecheck, lint and formatting pass; the full runner suite passes
3,030 tests with 35 skipped. Three regression cases fail on the old transition.
All 265 focused tests and six
real Linux agent scenarios pass after repair. Independent replay of all three
recorded Windows event sequences confirms the corrected transitions, including
conservative screen recovery for interruption. Evidence:
`repair-validation/claude-chat/REPORT.md` and
`repair-validation/claude-chat-review/REVIEW.md`. Native validation of this final
state-machine repair follows separately from the historical audit.

## Sample identity and method

| Identity                                          | Value                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| PR                                                | [#184](https://github.com/novadeck-org/novadeck/pull/184), draft |
| Frozen branch head                                | `9f9d12ba72543e2eddbdd7b2021e02fe22af907a`                       |
| Rebased main                                      | `9c88b133d7cc509dcdee6e54e77008dcb696bad0`                       |
| Actual checkout in all 546 archived checkout logs | `e27f69a627928014680c80d964fdd9efc9d2e681`, the PR merge commit  |
| Collection window                                 | October 15–16, 2026; final archive at 05:41:52 UTC on October 16 |

Rebase onto main preceded the opening push. The opening observation is separate
from the 20 counted reruns. Each rerun repeated all three complete workflows,
including passing jobs. Sampled source, diagnostics, PR description and Actions
debug settings stayed unchanged. Report updates remained local until collection
ended. No base drift was recorded.

Quality has 10 jobs: static checks, Linux/macOS/Windows tests, production and
visitor builds, and an aggregate Test gate. PR has one verification job. E2E has
16 jobs covering its planner, pinned Claude Code/Codex/Antigravity and Mixed
scenarios on all three platforms, plus three Windows quirks jobs. Release,
deployment and Dependabot workflows were outside this sample.

The collector checked status every 180 seconds. Before another rerun, it archived
full job logs, metadata, available failure artifacts, SHA-256 manifests and actual
checkout identities for all three workflows. Cancelled attempts, incomplete
matrices or unverified checkouts would have been excluded and investigated;
**none were excluded**. Failure observations stay counted when a later rerun passes.

## Results

| Workflow | Successful counted reruns | Counted job observations | Failed jobs other than aggregate gates |
| -------- | ------------------------- | ------------------------ | -------------------------------------- |
| Quality  | 19 / 20                   | 200                      | 1                                      |
| PR       | 20 / 20                   | 20                       | 0                                      |
| E2E      | 19 / 20                   | 320                      | 1                                      |

All workflows passed together in **18 / 20** reruns. The 540 counted job observations
include 20 Quality aggregate gates; 520 are other jobs. Quality's failed Test gate
in rerun 2 repeats its failed Windows matrix result and is not another defect.
The separate opening round has 27 job observations: Quality and PR passed; E2E
failed one Codex Windows job. No conditional toolchain setup retries were observed.

Across opening plus reruns, 63 workflow attempts and 567 job observations are
retained. Every round has its exact 10/1/16 matrix. All 546 checkout logs agree on
the merge commit above. Archive integrity and unchanged sampled source were
checked independently after collection.

## Run ledger

<!-- CI-LEDGER:START -->

| Round   | Quality                                                                                                 | PR                                                                                                      | E2E                                                                                                     | Result                                                     |
| ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Opening | [38808698594/1](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/1) success   | [38808698587/1](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/1) success   | [38808698573/1](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/1) failure   | E2E: Codex (Windows) (failure)                             |
| 1       | [38808698594/2](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/2) success   | [38808698587/2](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/2) success   | [38808698573/2](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/2) success   | All jobs passed                                            |
| 2       | [38808698594/3](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/3) failure   | [38808698587/3](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/3) success   | [38808698573/3](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/3) success   | Quality: Test (Windows) (failure); Quality: Test (failure) |
| 3       | [38808698594/4](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/4) success   | [38808698587/4](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/4) success   | [38808698573/4](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/4) success   | All jobs passed                                            |
| 4       | [38808698594/5](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/5) success   | [38808698587/5](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/5) success   | [38808698573/5](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/5) success   | All jobs passed                                            |
| 5       | [38808698594/6](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/6) success   | [38808698587/6](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/6) success   | [38808698573/6](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/6) success   | All jobs passed                                            |
| 6       | [38808698594/7](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/7) success   | [38808698587/7](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/7) success   | [38808698573/7](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/7) success   | All jobs passed                                            |
| 7       | [38808698594/8](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/8) success   | [38808698587/8](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/8) success   | [38808698573/8](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/8) success   | All jobs passed                                            |
| 8       | [38808698594/9](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/9) success   | [38808698587/9](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/9) success   | [38808698573/9](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/9) success   | All jobs passed                                            |
| 9       | [38808698594/10](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/10) success | [38808698587/10](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/10) success | [38808698573/10](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/10) success | All jobs passed                                            |
| 10      | [38808698594/11](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/11) success | [38808698587/11](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/11) success | [38808698573/11](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/11) success | All jobs passed                                            |
| 11      | [38808698594/12](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/12) success | [38808698587/12](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/12) success | [38808698573/12](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/12) success | All jobs passed                                            |
| 12      | [38808698594/13](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/13) success | [38808698587/13](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/13) success | [38808698573/13](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/13) failure | E2E: Mixed (Windows) (failure)                             |
| 13      | [38808698594/14](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/14) success | [38808698587/14](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/14) success | [38808698573/14](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/14) success | All jobs passed                                            |
| 14      | [38808698594/15](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/15) success | [38808698587/15](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/15) success | [38808698573/15](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/15) success | All jobs passed                                            |
| 15      | [38808698594/16](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/16) success | [38808698587/16](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/16) success | [38808698573/16](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/16) success | All jobs passed                                            |
| 16      | [38808698594/17](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/17) success | [38808698587/17](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/17) success | [38808698573/17](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/17) success | All jobs passed                                            |
| 17      | [38808698594/18](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/18) success | [38808698587/18](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/18) success | [38808698573/18](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/18) success | All jobs passed                                            |
| 18      | [38808698594/19](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/19) success | [38808698587/19](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/19) success | [38808698573/19](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/19) success | All jobs passed                                            |
| 19      | [38808698594/20](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/20) success | [38808698587/20](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/20) success | [38808698573/20](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/20) success | All jobs passed                                            |
| 20      | [38808698594/21](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/attempts/21) success | [38808698587/21](https://github.com/novadeck-org/novadeck/actions/runs/38808698587/attempts/21) success | [38808698573/21](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/attempts/21) success | All jobs passed                                            |

Normal reruns passed: Quality 19/20, PR 20/20, E2E 19/20. Opening is separate.
Frozen sample head: `9f9d12ba72543e2eddbdd7b2021e02fe22af907a`. Initial base: `9c88b133d7cc509dcdee6e54e77008dcb696bad0`.
Every counted round has a full matrix and verified, archived checkout IDs.
<!-- CI-LEDGER:END -->

## Observed failures

### P1: opening Codex Windows readiness stops at unknown trust

[Codex (Windows), opening attempt 1](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/job/116676274507)
failed `controls.e2e.ts > Codex, its folder untrusted > never rings an agent at its
folder-trust question, and rings it once trusted`. After accepting the trust
question, fox reached an empty Codex prompt, but stayed Unbound with its message
Queued. The Ready wait expired after 60 seconds.

The trace records valid Ready titles at +15.226 and +15.255 seconds. Both find
the harness; both trust checks finish as `unknown` at +25.230 seconds. No prompt
observation, later title or fox hook follows before teardown at +74.958 seconds.
This rules out missing title parsing or an already-bound-session shortcut for
this occurrence. The roughly 10-second query fits the helper deadline, but the
trace lacks the helper's exit reason, response IDs and stderr, so a timeout is
not directly established.

Controlled local checks with a stand-in helper and the actual prompt gate show
that Unknown suppresses readiness and is cached for 60 seconds. A recovered helper
can therefore remain hidden behind that cache for the rest of this test; expiry
alone schedules no retry. Those checks establish the gate/cache mechanism, not
the Windows cause. The [pinned transport processor](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/app-server/src/lib.rs#L1171-L1248)
processes requests in order; there is no evidence that simply awaiting the
initialize response would repair this failure.

Retained evidence: `evidence-postfix-30/sample-000/e2e/` and
`evidence-postfix-30/investigations/P1/`, including `REPORT.md`, the exact failed
test trace, `gate-cache-probe.log` and the cited `UPSTREAM_HANDSHAKE.md`.
Next evidence should record bounded helper startup, initialize/hooks-list
responses or errors, exit status, cache decisions and redacted stderr. Keep
Unknown distinct from confirmed Untrusted.

### P2: rerun 2 Grid drag reorders locally without undocking

[Quality Test (Windows), attempt 3](https://github.com/novadeck-org/novadeck/actions/runs/38808698594/job/116697521292)
failed `companions.spec.tsx > Undocking an item into a window of its own > when
dragged onto the Grid's free space > opens a window there`, at the first window
visibility assertion, line 596. This is the ordinary **12-move** drag. The separate
one-move activation/drop sibling passed in the same job.

The retained screenshot shows the plan still docked and no detached window.
Its taskbar order is Messages then Plan; the verified fresh fixture starts with
Plan then Messages. This supports a recognized local sortable reorder, rather
than an untouched source. It is an inference from the fixture and final screen,
not a captured drag event sequence. Storage clearing, root cleanup and fresh
backend construction rule out carrying the preceding test's slot order forward.

The screenshot cannot reveal release coordinates, hit-test results, cancellation
or the app's drop place. Empty Grid space at capture time does not establish
what was under the pointer at release. The cause and its relationship to the
previous local one-move failure or the repairs remain unresolved.

Retained evidence: `evidence-postfix-30/sample-002/quality/` and
`evidence-postfix-30/investigations/P2/`, including `REPORT.md`,
`RESET_EVIDENCE.md`, exact job logs and artifact `12010982483`. Its two PNG entries
are byte-identical aliases and count as one screenshot observation. A future
failed gesture needs source/index changes, cancellation, native release
coordinates, hit tests and app drop state recorded together.

### P3: rerun 12 replacement startup leaves Antigravity bound

[Mixed (Windows), attempt 13](https://github.com/novadeck-org/novadeck/actions/runs/38808698573/job/116775134648)
failed `lifecycle.mixed.e2e.ts > Claude Code, Codex, Antigravity > makes
Antigravity's messages gone when Claude Code starts in its terminal, telling the
sender`. The first Gone prerequisite timed out after 60 seconds. Ready and
sender-notification assertions were not reached.

The trace records Antigravity bound to moth, its exit command, a queued message,
and replacement Claude reaching its prompt. Claude's new SessionStart hook is
received and decoded at +14.668 seconds, with PID 6912. The old Antigravity
binding, PID 3652, remains at epoch 3 in Drafting until cleanup; the message stays
Queued. This is a received-but-unaccepted replacement observation, distinct from
the earlier Codex cases with no replacement observation and P1's Unknown trust.

The existing binding can block a different harness to protect nested agents.
A liveness check can clear an exited binding first, but the trace does not retain
old-PID liveness, connection/foreground results or the exact gate disposition at
hook arrival. PID 3652 is absent from a teardown process tree about 57.6 seconds
later; that does not prove it was absent when the hook arrived. Controlled local
live/dead PID checks confirm the gate behavior, not the Windows cause.

Retained evidence: `evidence-postfix-30/sample-012/e2e/` and
`evidence-postfix-30/investigations/P3/`, including `REPORT.md`, exact trace and
log extractions, artifact `12020074691`, verified hashes and
`binding-gate-probe.log`. Future tracing should capture process start identity,
old-PID liveness and errors, new PID and gate results at replacement startup,
with a still-live nested agent as a negative control. No liveness or retry repair
is justified by this occurrence alone.

## Evidence and validation

Raw evidence is retained in the task directory outside the public repository;
these paths are local handoff locations, not published artifact links. The offline
`evidence-postfix-30/failure-index.json` maps failures to workflow attempts, exact
ZIP members and line numbers, and keeps opening, normal and aggregate-gate counts
separate. `user-stop.json` records the authorized reduction and the verified stop
before rerun 21. The preserved sampler state/config retain the original 30-round
plan; their prepared next-round state is not evidence of a launched rerun.

Before the opening push, the rebased tree passed the full build and test suites,
format, lint, typecheck and actionlint. Runner tests passed 2,999 with 35 skipped;
UI tests passed 2,882 with 3 skipped. Scoped integration reviews passed. The
post-collection source fingerprint, excluding both reports, remains
`b869e7db7a26e57ad4a118221fc50fbdb04fe937f9dd58cf78e4b7892a8e2360`.
Local validation and the independent archive review are retained under
`postfix-validation/`.

## Limits

Twenty reruns describe this frozen source under the sampled CI conditions.
They do not prove that all flakes are gone. Main added behavior and tests before
the rebase, and cache state, runner scheduling and infrastructure can change;
comparisons with the previous audit are descriptive, not causal estimates of
the repairs' effect. The three observations above are not three established root
causes, and a later pass is not proof of a fix. Report publication changes only
documentation; any checks triggered by publication are outside this frozen sample.
