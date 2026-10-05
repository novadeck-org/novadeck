# Harness coverage

What Claude Code, Codex and Antigravity expose for each feature of the
[agent model](harness-adapters.md#agent-model), measured for step 3 of the
[harness adapters](harness-adapters.md#implementation-sequence) design. Levels use
`FeatureCoverage`: **complete** means both entering and leaving the state are
signaled, including failure and interruption; **partial** means some of it is;
**unsupported** means no usable native source exists.

Evidence:

- **Probed** means captured from a real run on 2026-09-29. Sanitized payloads are in
  `application/runner/src/harnesses/<id>/fixtures/`, and `fixtures.test.ts` checks
  the claims below that rest on them.
- **Documented** means the harness's own documentation, not yet seen in a run.

| Harness     | Version   | How it was measured                                                                                                                                                                                                                                                                    |
| ----------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | 2.1.285   | Probed: `claude -p`, and the interactive TUI driven in a PTY, both with every hook event registered through `--settings`. Documented: hooks, status line, agent view and monitoring references.                                                                                        |
| Codex       | 0.158.0   | Probed: `codex exec --json` and its rollout file, and the interactive TUI driven in a PTY, with hooks in a throwaway `CODEX_HOME` holding only the probe's hooks (`--dangerously-bypass-hook-trust`). Documented: hooks reference, generated hook and app-server schemas.              |
| Antigravity | 1.2.12–13 | Probed: `agy -p` and the interactive TUI driven in a PTY, in a scratch workspace whose `.agents/hooks.json` registered every event (the CLI updated itself to 1.2.13 between runs). Documented: the CLI's bundled `hooks.md`, the status line and title references, the CLI changelog. |

## Matrix

| Feature     | Claude Code                                                                                          | Codex                                                                                                      | Antigravity                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| session     | partial: `SessionStart` sources, `SessionEnd` reasons, `CLAUDE_PID` (probed); no signal on a crash   | partial: `SessionStart` sources, `SessionEnd`, thread id, parent `codex` (probed); normal end only         | partial: `conversationId` on every hook, parent `agy` (probed); no end event              |
| activity    | partial: an Esc interrupt or denial fires nothing; the transcript records it (probed)                | partial: `Interrupt` on Esc and on denial (probed); a failed turn fires nothing; the rollout records it    | partial: `PreInvocation`, `Stop` (probed); a denial or Esc fires nothing (probed)         |
| attention   | partial: `PermissionRequest`, also for questions; no id; a denial fires nothing (probed)             | partial: `PermissionRequest` without id; approval `PostToolUse`, denial `Interrupt` (probed)               | partial: `PreToolUse` then `PostToolUse` by `stepIdx`; a denial fires nothing (probed)    |
| actors      | partial: `SubagentStart`/`SubagentStop` and `agent_id` on tool hooks (probed)                        | partial: `SubagentStart`/`SubagentStop` and `agent_id` on tool hooks (probed)                              | unsupported by hooks; parent id only in `conversation_summaries.db`                       |
| transcripts | partial: session JSONL plus a file per subagent; undocumented records                                | partial: rollout JSONL, with `agent_message` from other agents; items appear only when completed (probed)  | partial: `transcriptPath` JSONL of steps; calls pair with results by step (probed)        |
| planning    | partial: `permission_mode: plan`; draft written to `~/.claude/plans`; `ExitPlanMode` review (probed) | partial: Plan Mode in the rollout (`collaboration_mode_kind`, a `Plan` item); hooks say `default` (probed) | partial: status line `cycle_mode`; plan artifact via PostToolUse `write_to_file` (probed) |
| usage       | partial: per-message usage in the transcript; cost only as a status line estimate                    | complete for tokens: `token_count` and `token_usage_record` (probed); no cost                              | partial: status line token totals and cost estimate                                       |
| limits      | partial: status line `rate_limits` only                                                              | complete: `rate_limits` windows with reset instants in `token_count` (probed)                              | partial: status line `quota` per model                                                    |
| context     | partial: status line `context_window`; `PreCompact`/`PostCompact`                                    | partial: `model_context_window` plus last response usage (probed); compaction hooks                        | partial: status line `context_window`; compaction has no signal                           |

## Claude Code

**Hooks.** 33 events. In the probe:

- Every payload carries `session_id`, `transcript_path` and `cwd`.
- Every payload after the first prompt also carries `prompt_id`.
- Tool events carry `tool_use_id`.
- Events inside a subagent add `agent_id` and `agent_type`, and keep the root's `session_id`.
- Hooks run with `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR` in their environment.

`CLAUDE_PID` names the Claude Code process, which is root-instance evidence for `same-root-instance`.

**Sessions.**

- `SessionStart.source` is `startup`, `resume`, `clear`, `compact` or `fork`.
- `clear` and `fork` mint a new session id.
- `SessionStart` waits for the trust dialog and the first-run onboarding: it fired neither while they showed (5 and 10 s) nor when Esc left the trust dialog, which exits. Once past them, at a `startup`, `resume` or `clear`, it fired within about 150 ms of the empty input prompt drawing, before or after it. Logged out but onboarded, Claude Code shows its own prompt ("Not logged in · Run /login"), with `SessionStart`, and no login screen. `claude --resume` without an id shows its session picker first, with no `SessionStart` for 8 s, and Esc there exits with none. `--resume <id> --fork-session` fired `SessionStart` with source `fork` at about 700 ms, its prompt already up; `--continue` fired a `resume`. Keys typed 150 ms after launch, before the prompt drew, were dropped (probed 2026-10-01, 2.1.287, a throwaway `CLAUDE_CONFIG_DIR`).
- `SessionEnd.reason` is `clear`, `resume`, `logout`, `prompt_input_exit` or `other`.
- Closing the terminal (SIGHUP) fired `SessionEnd` with reason `other` (probed). A crash or SIGKILL should fire nothing (not probed), so the PTY exit remains the fallback.

**Activity.**

- `UserPromptSubmit` starts a turn.
- `Stop` ends it normally.
- `StopFailure` ends it on an API error. It carries `error` (`rate_limit`, `overloaded`, `billing_error`, …) and replaces `Stop`.
- An Esc interrupt fires no hook, not even `Stop` or `PostToolBatch` (probed with every event registered: Esc during a running Bash call). The transcript records the call's `tool_result` with `is_error` and a user record `[Request interrupted by user for tool use]`, which marks the end of the turn (probed).
- Transcript saving is off when Claude Code inherits `CLAUDE_CODE_CHILD_SESSION`, as a process started from another Claude Code session does (probed: the TUI says so). NovaDeck's shells must not pass that variable on, or the transcript fallback disappears.
- `claude agents --json` reports `busy`, `waiting` or `idle` per session and is documented as the supported way to read state from outside. It is a polled command, not a stream.

In the probe, a background subagent's result began a second turn with its own `UserPromptSubmit` and `Stop`. So a turn does not always start with the person typing.

- `Stop` lists `background_tasks`, each with its `type` (`subagent`, `shell` for a Bash command run in the background) and `status`. Once a running one finishes, Claude Code starts a turn by itself with a `<task-notification>` prompt, whose `Stop` lists what still runs; a background subagent and a background command each did (probed 2026-10-04, 2.1.289). A task that finishes while the turn still runs is handed back in a turn after its `Stop` too.
- Each time a root turn's Stop hooks run, the transcript gets a `{"type":"system","subtype":"stop_hook_summary"}` record, with `hookErrors` and `isSidechain: false`, whether NovaDeck's hook ran or failed to (seen in 2.1.286 to 2.1.289 transcripts; one held "Failed to run: Plugin directory does not exist"). It is written once the hooks have finished, so after NovaDeck's hook was answered. A Stop hook that blocks writes a `hook_blocking_error` attachment before it, and the turn goes on.

**Attention.**

- `PermissionRequest` fires as the prompt opens. It carries `tool_name`, `tool_input` and `permission_suggestions`, but no `tool_use_id` or request id.
- `PreToolUse` fires just before it with the `tool_use_id` (probed), but nothing ties the two, so NovaDeck derives the request's id from the actor, the tool and a hash of the call's input, as the call's `PostToolUse` derives it too (see [Harness adapters](harness-adapters.md)).
- Approval shows only when the tool finishes, as that call's `PostToolUse` (probed): nothing fires between the approval and the result. While an approved long command runs, the request looks pending; `claude agents --json` reporting `busy` rather than `waiting` is the only other source (documented).
- A denial by the person fires nothing, not even `Stop` or `PostToolBatch` (probed interactively with every event registered). `PermissionDenied` covers auto mode only. The transcript records the call's `tool_result` with `is_error`, the interruption and `turn_duration`, so the transcript ends the request and the turn. An approved call interrupted with Esc leaves the same records, so the outcome stays unknown.
- A background subagent's request denied by the person, with Esc or its "No" key, fires no hook either, but the subagent gets the denial as the call's `tool_result` ("Permission for this tool use was denied…", in `subagents/agent-<id>.jsonl`) and runs on: here it answered and ended with `SubagentStop` (probed 2026-10-03, 2.1.287).
- In print mode (`-p`), where no one can answer, the denied call is instead listed in `PostToolBatch` with its `tool_use_id` (probed).
- Questions are the `AskUserQuestion` tool. It fires `PreToolUse`, then `PermissionRequest` like any tool (probed), so the question's kind comes from `tool_name`. Its `PostToolUse` carries `tool_response.answers`, keyed by question text (probed). MCP elicitations have `Elicitation` and `ElicitationResult` with an `elicitation_id`.
- `PermissionRequest`, `Elicitation` and `PreToolUse` can answer: a later `respond`/`answer` capability has a native path.

**Actors.**

- `SubagentStart` and `SubagentStop` carry `agent_id` and `agent_type`, and `SubagentStop` adds `agent_transcript_path`.
- The parent's `Agent` tool call links to the child through `subagents/agent-<id>.meta.json` (`toolUseId`), an undocumented file.
- Internal agents (prompt suggestions, `/btw`) also fire `SubagentStart`/`SubagentStop` (documented). One probe run saw a `SubagentStop` with an empty `agent_type` and no `SubagentStart`; no fixture was kept. Ignore a stop for an agent never seen starting.
- Subagent failure or interruption has no distinct signal.

**Transcripts.**

- Location: `~/.claude/projects/<cwd slug>/<session>.jsonl`, plus `subagents/agent-<id>.jsonl`.
- Records chain by `uuid`/`parentUuid`, and tool calls link by `tool_use_id`.
- Record types beyond `user`, `assistant` and `system` are internal and change between versions.
- The file is written asynchronously and may lag the hooks.

**Planning.**

- Hooks carry `permission_mode`; `plan` means planning mode. No hook fires on the mode change itself; the status line reruns on it.
- While planning, Claude Code writes the draft with the `Write` tool to `~/.claude/plans/<name>.md` (probed), so `Write` hooks on that directory are a native draft signal.
- `ExitPlanMode` asks for review: `PreToolUse` then `PermissionRequest`, both with `plan` (Markdown) and `planFilePath` in `tool_input` (probed). Its `PostToolUse` means the plan was approved.
- Rejecting the plan fires nothing, as a denial does (probed); the transcript records it the same way.

**Usage, limits, context.**

- **Transcript:** `assistant.message.usage` has input, output and cache counts. Several records can belong to one API response, so deduplicate by `requestId`.
- **Status line:** the JSON on stdin has
  - `cost.total_cost_usd` (a client-side estimate),
  - `context_window` (size, `used_percentage`, current usage),
  - `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` (0–100) and `resets_at` (epoch seconds).
- `rate_limits` appears only for subscription accounts, and only after the first response. A missing window is unknown, not zero.
- No other source carries rate limits.

## Codex

**Hooks.** 12 events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop` and `Interrupt`.

- Every payload carries `session_id`, `cwd` and `transcript_path` (the rollout). All but `SessionEnd` also carry `model` and `permission_mode` (probed).
- Turn-scoped events carry `turn_id`.
- Tool events carry `tool_use_id`, except `PermissionRequest`.
- Hooks run as direct children of the `codex` process (probed), so the hook's parent process identifies the Codex instance.
- The hook's environment carries no thread id (probed).
- A spawned subagent's `SubagentStart` and tool events carry its `agent_id` and its own `turn_id`, under the root's `session_id` (probed). Spawning shows as the tool `collaborationspawn_agent`. Its hooks give the root's rollout as `transcript_path`; only its `SubagentStop`'s `agent_transcript_path` names its own, `rollout-<time>-<agent_id>.jsonl` beside the root's (probed 2026-10-03, 0.159.3).
- A plugin's hooks stay inert until the person reviews and trusts them in `/hooks`. Trust is kept against the hook definition's hash, and no hook announces the missing trust. The app-server's `hooks/list` reports it.

**Sessions.**

- `SessionStart.source` is `startup`, `resume`, `clear`, `compact` or `fork`.
- Interactive Codex fires `SessionStart` only with the first prompt submitted, about 50 ms before its `UserPromptSubmit`; idle at its prompt it fired nothing for 10 s, and `/clear` fired nothing in the 5 s after it (probed 2026-10-01, 0.159.3, `--no-daemon`, a throwaway `CODEX_HOME`).
- Its terminal title tells when its own prompt shows, before any `SessionStart`: given the items `status` and `thread-id` (`-c tui.terminal_title=['status','thread-id']`, as NovaDeck's shim passes), it read "Ready | <the start of its thread's id>..." about 440 ms after its prompt drew, at a plain start, after `/clear` (the new thread's id, the one `SessionStart` names at the next prompt) and at `codex resume <id>`; "Working" during a turn, "Ready" after. It set no title at all while its folder-trust dialog, "Hooks need review" screen, sign-in screen, update screen ("Update available", from a newer version planted in `version.json`, killed without a key pressed) or the bare `codex resume` picker showed. The `thread` item shows the whole id only while the thread has no name, so `thread-id` it is. After Esc skipped the hooks review it said Ready with the hooks not running (probed 2026-10-01, 0.159.3).
- Its title follows the thread it shows: its TUI swaps the chat view for an agent or side thread it switches to (`replace_chat_widget`, 0.159.3 source), and `/side` turned it to the fork's id, whose `SessionStart`, at its first prompt, said `fork`; every hook of that ephemeral thread gives `transcript_path` as null (probed 2026-10-02 in the e2e sandbox). `/clear` fires no `SessionEnd`. Codex writes and holds `thread-writer-locks/<thread id>.lock` for each thread it starts, at a plain start and at `/clear`, and none for a `/side` fork; the TUI process holds it open (probed 2026-10-01, 0.159.3).
- Every non-ephemeral thread takes a writer lock as it is made or resumed (`live_writer::create_thread` and `resume_thread` call `acquire_writer_lock`; `rollout/src/writer_lock.rs` creates `<thread id>.lock` and holds it locked until the thread's writer drops it, then removes it). A spawned agent's thread is one (its `CreateThreadParams` carry `parent_thread_id`), made when the root's turn spawns it; an ephemeral thread (`config.ephemeral`, as `/side`) takes none. The lock's file isn't rewritten while held. Viewing an agent thread swaps the chat view and the title, but the TUI enables agent navigation only with Codex's local daemon (`set_agents_navigation_enabled`, `AppServerTarget::LocalDaemon`), which `--no-daemon` turns off (source, 0.159.3).
- Its app-server's `hooks/list` (`codex app-server`, JSON-RPC over stdio: `initialize`, `initialized`, then `hooks/list` with `cwds`) lists each hook with its `pluginId`, `eventName`, `currentHash` and `trustStatus`: `trusted`, `untrusted`, or `modified` since trusted; about 150 ms. Trust is recorded in `config.toml` as `[hooks.state."<plugin>:<file>:<event>:<i>:<j>"] trusted_hash`; with the listed hashes recorded there, the TUI showed no review and ran the hooks without `--dangerously-bypass-hook-trust` (probed 2026-10-01, 0.159.3).
- `SessionEnd` fires on a normal end only.
- The thread id from `codex exec --json`, the rollout file name and `session_meta.id`/`session_id` are the same value, and the hook's `session_id` is that id (probed).
- `CODEX_THREAD_ID` reaches commands Codex runs, not the TUI.

**Activity.**

- `UserPromptSubmit` starts a user turn; the rollout's `task_started` covers every turn.
- `Stop` ends a turn. `Interrupt` fires with the turn's `turn_id` when Esc interrupts a running tool, with no `PostToolUse` or `Stop` after it (probed); the rollout records `turn_aborted`.
- A failed turn fires no hook. The rollout records its end as `task_complete` with an `error` (`{message, codex_error_info}`, as `server_overloaded`), and an aborted one as `turn_aborted` with a `reason`, each with the turn's `turn_id`, which `UserPromptSubmit` names too (probed 2026-10-04, 0.159.3: the fake model refusing the request, and answering 500 until Codex gave up after about 25 s of retries). Codex may write a turn's records long after it ended: three failed turns' records, before the session's first good turn, all came with one later timestamp. In a turn that completes, the rollout's `task_complete` is written after the `Stop` hook was answered.
- Nothing a turn starts wakes it once the turn has ended: a spawned subagent or a command left running (a "background terminal") finishes with the root idle (probed 2026-10-02, 0.159.3).

**Attention.**

- `PermissionRequest` carries `tool_name` and `tool_input` but no id. It follows the call's `PreToolUse`, the same as for Claude Code (probed).
- Approval shows as that call's `PostToolUse` (probed). A denial (Esc) fires `Interrupt` for the turn (probed), which resolves the request and ends the turn.
- A spawned subagent's request (`multi_agent_v1`, under `--no-daemon`) shows in the root's TUI as "Thread: Agent (<id>)". Its `PermissionRequest` and, once allowed, its `PostToolUse` carry its `agent_id`, and its turn's end fires `SubagentStop`, not `Stop`. Esc on it closes the dialog and fires no hook at all, neither `Interrupt` nor `SubagentStop`: only the subagent's own rollout records `turn_aborted`, and the subagent stays open (probed 2026-10-03, 0.159.3). NovaDeck follows that rollout while the subagent's request waits, and takes the abort as the end of that subagent's turn: its requests settle, and it still runs.
- Approvals are not written to the rollout.
- `request_user_input` is a function tool, and whether it reaches `PreToolUse` needs a probe.
- `PermissionRequest` can answer `allow` or `deny`.

**Actors.**

- `SubagentStart` and `SubagentStop` carry `agent_id` and `agent_type`, and `SubagentStop` adds `agent_transcript_path`.
- Each subagent has its own rollout whose `session_meta.source.subagent.thread_spawn` names the parent thread.
- Internal threads (`review`, `compact`, `guardian`, `memory_consolidation`) are not the person's agents.

**Transcripts.** The rollout is JSONL at `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`.

- Records are `session_meta`, `turn_context`, `event_msg` (`task_started`, `item_completed`, `token_count`, `task_complete`, `turn_aborted`, `context_compacted`, …), `response_item`, `token_usage_record`, `world_state` and `compacted`.
- Items appear only once completed (probed), so a running command is visible only through `PreToolUse`.
- The format is undocumented and changed recently (`history_mode`, `migrate-rollouts`).

**Planning.** Plan Mode is a collaboration mode, entered with `/plan` in the TUI. Hooks keep `permission_mode: default` in it (probed, 0.159.2). The rollout says it: each turn's `task_started` names `collaboration_mode_kind: plan` (written before the SessionStart hook that binds a session, so NovaDeck reads the rollout's latest mode and plan when it starts following it), `turn_context.collaboration_mode.mode` is `plan`, and the proposed plan is an `item_completed` event whose item is `{type: "Plan", text}` (Markdown), also wrapped in `<proposed_plan>` in the assistant's message. The `update_plan` checklist tool the binary still documents was offered to the model in neither mode.

**Agent messages.** `response_item`s of type `agent_message` carry `author` and `recipient` agent paths (`/root`, `/root/<name>`) and content of `input_text` plus `encrypted_content`. Across 2,700 local rollouts, each holds only the messages its own agent received: a subagent's from its parent (or another agent), the root's from its subagents.

**Usage, limits, context.** The rollout's `token_count` holds:

- `info.total_token_usage` (cumulative for the thread) and `info.last_token_usage` (the latest response): input, cached, cache write, output, reasoning and total tokens.
- `info.model_context_window`.
- `rate_limits.primary` and `rate_limits.secondary`, each with `used_percent` (0–100, probed), `window_minutes` and `resets_at` (epoch seconds, probed). `secondary` can be null.

Other facts:

- `token_usage_record` gives usage per response and per turn.
- No source reports a cost.
- Occupancy is estimated from the last response's input tokens over `model_context_window`.

## Antigravity

**Hooks.** Five events: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop`.

- Every payload carries `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath` and `modelName`.
- `PreToolUse` can allow, deny or ask; `PostInvocation` and `Stop` can force the loop to continue.
- Hooks run through `sh`, whose parent is the `agy` process (probed), so the hook's grandparent identifies the Antigravity instance.
- The hook's environment has `ANTIGRAVITY_CONVERSATION_ID` (probed). It also inherits every ancestor's variables: probed under Claude Code, it carried `CLAUDE_PID`. An environment variable therefore never proves which harness sent a report.
- Workspace hooks in `.agents/hooks.json` ran without a trust prompt in print mode; the interactive TUI asked to trust the folder first (probed).
- **A `PreToolUse` answer without a `decision` is a denial** (probed: `{}` denied every tool with "tool call denied by pre-tool hook"). An observing hook must answer `{"decision": "ask"}`, which leaves the person's own permission policy in charge; `force_ask` always shows the confirmation.

**Sessions.**

- `/clear`, `/resume` and `/fork` switch conversations inside one process. The only sign is a new `conversationId` on the next hook, from the same `agy` process (probed with `/clear`).
- Its status line runs from the start, every 300 ms or so: `agent_state` "authenticating", then "initializing", then "idle" about 200 ms after its prompt drew. It stayed "initializing" throughout its folder-trust dialog and "authenticating" behind its sign-in screen, never "idle". A plain start's idle names no `conversation_id` until the first prompt starts one; after `/clear` it names the new conversation at once, idle; `--conversation <id>` and `--continue` name the resumed one, idle (probed 2026-10-01, 1.2.14, a throwaway `HOME` with `AGY_CLI_DISABLE_AUTO_UPDATE=true`, which it logs as honoured, and `onboardingComplete: true` in its settings, without which a first run shows a colour-scheme picker, the status line already running).
- `AGY_CLI_DISABLE_AUTO_UPDATE` takes `true`, not `1`: with `1` it spawned its background updater (which found nothing newer) (probed 2026-10-01, 1.2.14).
- Nothing marks the end of a session.

**Activity.**

- `PreInvocation` fires before each model call; `PostInvocation` fires after it.
- `Stop` ends the execution loop with `terminationReason`, `error` and `fullyIdle` (false while background tasks run). The probe saw `NO_TOOL_CALL`, where the documentation lists `model_stop`, `max_steps_exceeded` and `error`, so decoders must accept values beyond those.
- A completed tool fires `PostToolUse` with the `stepIdx` of its `PreToolUse` (probed). A failed or denied one fires no `PostToolUse`.
- Denying a confirmation fires nothing more for that turn: no `PostToolUse`, `PostInvocation` or `Stop` (probed).
- Esc fires nothing: pressed during a reply, no `PostInvocation` or `Stop` followed; pressed while an approved command ran in the foreground, no `PostToolUse` or `Stop` followed (probed). The transcript drops the cancelled steps.
- An approved command still running after about 2 s moves to the background: the turn ends with `Stop` and `fullyIdle: false` while it runs (probed). `run_command`'s `WaitMsBeforeAsync` sets how long it waits first, from 500 ms. The command's end wakes the agent with a message, starting a turn of its own (probed 2026-10-04, 1.2.14).
- A subagent from `invoke_subagent` runs on after the root's `Stop` (`fullyIdle: false`), and its end wakes the root the same way. The status line lists it under `subagents` (`{name, role, status}`, `running` then `completed`), but never lists a command it backgrounded (probed 2026-10-04, 1.2.14).

**Attention.**

- There is no permission hook. Whether a confirmation shows depends on the person's policy, so `PreToolUse` alone does not mean one is open.
- The status line's `tool_confirmation_pending` says a confirmation dialog is open, without naming the step. With the preceding `PreToolUse`, it identifies the request.
- The confirmation offers yes, yes for this conversation, yes persisted, and no. Approval shows as `PostToolUse` for the step; a denial ends the turn silently.
- The `ask_question` tool probably shows as `PreToolUse`, pending a probe.

**Actors.** Subagents are separate conversations. Hooks do not say whether they fire for them. `conversation_summaries.db` records `parent_conversation_id` and `nesting_depth`.

**Transcripts.** Every hook names the transcript, `transcript_full.jsonl` under `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/` (probed, 1.2.13); `transcript.jsonl` beside it holds the same records with long fields truncated. Each line is a step: `step_index`, `source` (`USER_EXPLICIT`, `MODEL`, `SYSTEM`), `type` (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `SYSTEM_MESSAGE`), `created_at`, `content`, and on a model response `thinking` and `tool_calls` (`{name, args}`, no id). A result step's `status` is `DONE`, `ERROR`, or `RUNNING` for a command still running; whether a finished one is appended again is unprobed (no local transcript repeats a step). A tool call's result is the `GENERIC` step as many steps on as its place in the call list, plus one: three calls made at once in step 1 got their results as steps 2, 3 and 4, a failed call included (probed). Lines are not in step order: results made at once can be written before the step that made the calls. The person's input wraps their words in `<USER_REQUEST>`, followed by context blocks (`ADDITIONAL_METADATA`, `PLAN`, …). Compaction is internal: the binary has a trajectory compaction and an `ON_COMPACTION` lifecycle hook, but no command a person can run (`/compact` is not a slash command in print mode or the TUI; typed, it reaches the model as text). So a rewrite on compaction stays unprobed short of filling the context; through the probes (1.2.13 and 1.2.14) the file was only ever appended to, keeping its inode. NovaDeck's reader resets on a file that shrinks or is replaced, should compaction rewrite it.

**Plans.** In plan mode (`--mode plan` or `/plan`) the agent writes its plan with `write_to_file` as an artifact, `implementation_plan.md` in the conversation's `brain` folder, whose `ArtifactMetadata.RequestFeedback` is true; a walkthrough after implementing does not ask for feedback. Both sit in the folder hooks name as `artifactDirectoryPath`, the conversation's own. PreToolUse and PostToolUse both fire with `toolCall: {name, args}` and `error` (probed), so NovaDeck's plugin registers PostToolUse for `write_to_file` only, answered with `{}`. The status line names the conversation but not its transcript; a later hook does.

**Planning.** Plan mode exists (`--mode plan`, `/plan`), and the status line reports `cycle_mode`: `plan` or `accept-edits`, absent in the default mode (probed with `--mode`). Plans, task lists and walkthroughs are artifacts under `artifactDirectoryPath`. No signal marks a plan's approval.

**Usage, limits, context.** The status line only. Its JSON on stdin has:

- `agent_state` (`idle`, `thinking`, `working`, `tool_use`, `initializing`),
- `context_window` (size, used percentage, token totals),
- `quota` per model (`remaining_fraction`, `reset_time`, `reset_in_seconds`),
- `cost`, `task_count` and `pending_input_count`.

It also carries the account's `email`, which must not leave the adapter.

## Consequences for the design

1. **A status line bridge is the only route to some features.** It is the only live source for:
   - Claude Code's rate limits and context occupancy,
   - Antigravity's agent state, attention, usage, limits and context.

   A status line is a single user-level setting. For feature parity NovaDeck installs a bridge command that forwards to the person's own status line command, so their status line keeps working. For Claude Code, NovaDeck's shells can pass `--settings` at launch, as the Codex shim does for its flag, so the bridge applies only to NovaDeck's terminals. See [the design](harness-adapters.md#native-sources).

2. **Permissions have no request ids, and approval is seen only at completion.** A request's id is derived from its actor, its tool and a hash of the call's input, which the call's `PostToolUse` derives too; Antigravity's one confirmation at a time is the fixed `confirmation` (see [Harness adapters](harness-adapters.md)). A matching `PostToolUse` means allowed, but it fires when the tool finishes, so an approved long command keeps its request looking pending. Claude Code's `claude agents --json` (`busy` versus `waiting`) and Antigravity's `tool_confirmation_pending` can close that gap; Codex exposes approval state only through its app-server.
   - A denial fires nothing in Claude Code and Antigravity. Claude Code's transcript records an interruption, which an approved call interrupted with Esc also leaves, so it ends the request without saying which.
   - A denial fires `Interrupt` in Codex.
   - Otherwise the actor moving on resolves the request with an `unknown` outcome: the root's next turn start or end, or a subagent's stop or its turn's abort. A subagent's next request or its result for another call does not, and one answered with no report waits until its subagent stops (see [Harness adapters](harness-adapters.md) for the per-actor rules).
3. **NovaDeck's Antigravity hook must answer `PreToolUse` with `{"decision": "ask"}`.** An empty answer denies every tool.
4. **Interruption is harness-specific.**
   - Codex fires `Interrupt`.
   - Claude Code fires nothing; its transcript records the interruption and the turn's end.
   - Antigravity fires nothing, and its transcript drops the cancelled steps. Its status line's `agent_state` returning to `idle` is the remaining signal; a probe saw it after a denied confirmation.

   Without such a source, a turn stays `working` until the next event, and coverage says so.

5. **Every harness identifies its instance through the hook's process ancestry.**
   - Claude Code sets `CLAUDE_PID`.
   - A Codex hook's parent is `codex`.
   - An Antigravity hook's grandparent, through `sh`, is `agy`.

   The hook host should report the nearest ancestor whose executable is the harness, found through its `programs`. That gives `same-root-instance` evidence for all three, so Antigravity's `conversation-observed` switching can tighten. Linux was probed; macOS and Windows need their own process lookup. Inherited environment variables cannot stand in for it.

6. **Limits are percentages, not token counts.** Every harness reports windows as a used or remaining fraction with an absolute reset instant: Claude Code and Codex in epoch seconds, Antigravity as a time. None reports the limit itself, so the telemetry model stores fractions and never derives token amounts.
7. **Codex hook trust is a separate readiness state.** A connected Codex with untrusted hooks reports nothing. Detecting that needs the app-server's `hooks/list`, not a hook.
8. **One installed plugin serves every NovaDeck build.** Each harness keeps one copy of NovaDeck's plugin per user, from whichever build connected it last, so a terminal's own runner names what it starts. Hooks run `$NOVADECK_HOOK`, and on Linux and macOS the MCP server the launcher in `NOVADECK_MCP`, both set by the terminal's own runner, with the connecting build's launcher as the MCP server's fallback outside NovaDeck; on Windows it is the connecting build's relay, which still carries the agent's messages to the terminal's own runner (see [harness adapters](harness-adapters.md#local-mcp)). Each harness starts an MCP server's command without a shell. Claude Code and Antigravity give it the agent's environment, and Codex only the variables `env_vars` lists (probed in the e2e suite, `messaging.e2e.ts`). Claude Code expands `${VAR}` and `${VAR:-default}` in an MCP configuration itself (documented), so the command holds neither.

## Working past a turn's end

An agent works, as NovaDeck shows it, while its turn runs, and after the turn while
subagents it started run on, which wake it once done: Working ends only once its own
turn has ended and no subagent of it still runs. Other work a turn leaves running, as a
command run in the background, shows as left running (a badge, "1 task"), but keeps
nothing working: a dev server, a watcher or `tail -f` may run for ever. `wakes` on each
harness says whether anything wakes it.

| Harness     | What a turn leaves running                                                                                       | How NovaDeck counts it                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Background subagents and commands, listed by `Stop`, each waking it once done                                    | `Stop`'s running `background_tasks`: `subagent` ones as agents, which keep it working, the rest as tasks, which don't; where no `Stop` says, its running subagents          |
| Codex       | Nothing that wakes it: its subagents and commands finish with the root idle                                      | Never waits: its turn's end is the end of Working                                                                                                                           |
| Antigravity | Subagents and backgrounded commands, which `Stop` says only exist (`fullyIdle: false`), each waking it once done | Working until its next idle status line counts its running `subagents`, then only while it counts one; what else `Stop` said runs shows as background work, keeping nothing |

The wait ends with the turn the work's end starts, at that turn's own end with nothing
running, or with any later turn, as the person's. Antigravity's idle status line
listing no subagent running ends it too, leaving any command it backgrounded shown but
not waited on. Codex's parity gap is the harness's own: nothing there wakes, so nothing
is waited on. Delivery waits the same way, so the doorbell may ring an agent with only a
command left running, and `agents` calls it busy only while it works.

A Stop NovaDeck continues with messages keeps the turn running until the continuation's
own Stop, as Claude Code and Codex start the continuation with no prompt hook. Should its
hook never acknowledge the messages, the lease lapses and the turn ends at that Stop
after all.

A turn's end its hook never reported (NovaDeck's hook failed to run, or a Codex turn
failed, which fires none) comes from the session's own records: Claude Code's
`stop_hook_summary`, Codex's `task_complete` or `turn_aborted` for the running turn's id,
and Antigravity's idle status line. Such a record ends only the turn still running, its
continuation included, and leaves the hook's own `Stop`, should it arrive after all, to
say what still runs. Claude Code writes one for a Stop NovaDeck continued too, once its
hook answered (probed 2026-10-04, 2.1.289): each continued Stop uses up the next record
that names no turn, which ends nothing. Codex writes none for a continued Stop, and its
records name their turn. Antigravity's continuation's model calls after the continued
Stop are that continuation's own, so an idle status line after them ends it. Claude
Code's record says nothing of the background, so its running subagents count.

## A finished turn and its last reply

The done signal (see the README) needs to tell how a turn ended and what the agent said
last. `TerminalSummary.activity.lastTurn` carries both once no turn runs: the outcome, the
start of the reply as one line of plain text, 120 characters at most (`replyPreview`),
never the whole reply, and `at`, which tells one end from another.

| Harness     | How the turn ended                                                                                                               | Its last reply                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `Stop` completed, `StopFailure` failed, the transcript's interrupt marker interrupted, `stop_hook_summary` completed as recorded | `Stop`'s `last_assistant_message` (the hook keeps its first 4096 characters). A `Stop` or `StopFailure` naming none, as neither names the transcript, reads the bound session's transcript the runner follows: its last assistant text since the person's prompt, which Claude Code writes about 50 ms after its Stop hook starts (e2e, 2.1.287), so the runner looks up to four times, 100 ms apart. `stop_hook_summary` names none, and nothing is read for it |
| Codex       | `Stop` completed, `Interrupt` interrupted; the rollout's `task_complete` (failed with an `error`) and `turn_aborted` as recorded | `Stop`'s `last_assistant_message`; a `Stop` naming none reads the bound session's rollout, its last assistant message since the person's. A turn only the rollout ended takes `task_complete`'s `last_agent_message`                                                                                                                                                                                                                                             |
| Antigravity | `Stop` completed, or failed with an `error`; an idle status line with no `Stop` (an Escape or a refusal) is unknown              | `Stop` names none: the runner reads the transcript the same hook names, its last `PLANNER_RESPONSE` text since the person's last input, once the hook comes; it is written by then (e2e, 1.2.14)                                                                                                                                                                                                                                                                 |

A finish is a turn end the client hasn't seen before, by its `at`, that completed or
failed, shown as the agent rests: no subagent of it running and nothing waiting on the
person, whatever background command it left running. One that failed is a finish too, but
says it stopped with an error. An interrupt, or Antigravity's unknown idle, is the person's
own doing, and no finish. What a client shows when it first lists a terminal is taken as
seen, so a reload or a reconnect brings no finish again. An end only records told shows
the plain "Finished its turn." (or "Its turn failed."): the notification goes as the end
does, and the hook's own `Stop`, should it come after all with the reply, fills in the
summary's reply for the same end, never the notification already shown.

Parity gap: Antigravity's only fallback end, an idle status line where its `Stop` never
came, is `unknown`, which can't be told from an Escape or a refusal, so it never counts as
a finish. A lost Antigravity `Stop` therefore gives no done signal, where Claude Code's
transcript and Codex's rollout still give one.

## Still to probe

- Claude Code: plan mode entered with Shift+Tab mid-session, which of `StopFailure` and the transcript ends a failed turn (one the API refused ended, 2026-10-04), subagent interruption, and the `agent_type` internal agents report.
- Codex: `request_user_input`, and whether internal threads fire `SubagentStart`.
- Antigravity: `ask_question`, subagent hooks, the status line after an Esc, and compaction's rewrite of the transcript.
- The status line bridge in a live NovaDeck terminal, for Claude Code and Antigravity.
- macOS and Windows: the hook's process ancestry, and every probe above.
