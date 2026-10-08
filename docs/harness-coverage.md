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

| Harness     | Version   | How it was measured                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | 2.1.285   | Probed: `claude -p`, and the interactive TUI driven in a PTY, both with every hook event registered through `--settings`. Documented: hooks, status line, agent view and monitoring references.                                                                                                                                           |
| Codex       | 0.158.0   | Probed: `codex exec --json` and its rollout file, and the interactive TUI driven in a PTY, with hooks in a throwaway `CODEX_HOME` holding only the probe's hooks (`--dangerously-bypass-hook-trust`). Documented: hooks reference, generated hook and app-server schemas.                                                                 |
| Antigravity | 1.2.12–16 | Probed: `agy -p` and the interactive TUI driven in a PTY, in a scratch workspace whose `.agents/hooks.json` registered every event (the CLI updated itself to 1.2.13 between runs); later runs, up to 1.2.16, used a throwaway `HOME`. Documented: the CLI's bundled `hooks.md`, the status line and title references, the CLI changelog. |

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
- Esc before any reply came takes the prompt out of the conversation and puts it back in the input box, whole and multi-line, with no echo above it; Esc Esc written together then clears the box's text, single or multi-line, where Ctrl+U clears only a line (the last of a multi-line draft) and Ctrl+A Ctrl+K only the rest of one. Esc Esc over an empty box opens the rewind picker, so it is pressed only over a draft seen on the screen (probed 2026-10-06, 2.1.287, the e2e sandbox with the fake model).
- Its input box sits between two `─` rules at the bottom of the screen, `❯ ` leading the first row and the rest indented, the cursor on the last row; it grows upward and a turn's spinner and tip sit above the rules. Empty it shows `❯` alone (the fake-model sandbox draws no `Try "…"` suggestion; older builds drew one dim, which the runner's reader ignores by the cell's dim attribute). A paste of 3 lines shows whole, 4 or more (even short) show `[Pasted text #1 +3 lines]`, and one of over about 800 characters (800 showed, 900 did not) `[Pasted text #5]`; text pasted after a placeholder follows it on the next row. Ctrl+U clears one line only. Below the box it keeps its rule and a footer row or two, so a box may take the screen's rows less 4. Mid-turn the box is the same (probed 2026-10-07, 2.1.287 and 2.1.292, `e2e/probes/input-box.e2e.ts`, fixtures/input-box.probe.json).
- Queued messages and Escape (probed 2026-10-07, 2.1.287 and 2.1.292, `e2e/probes/queued-stop.e2e.ts`): a prompt given mid-turn shows above the box with "ctrl+x ctrl+s to send now", and the empty box shows the faint "Press up to edit queued messages" with the cursor's cell over its "P" drawn undimmed (so a reader must not take it for a one-letter draft). One Escape stops the turn ("Interrupted · What should Claude do instead?") and sends the queued message as the next turn; a second stops that turn and, before any reply, puts the queued messages back in the box (two queued came back as `Queued beta`, `Queued gamma`, one per line); Escape twice at once leaves them in the box directly. A box holding that text is cleared by Escape twice (also the way a restored prompt is). Ctrl-U clears only the line; Escape twice over an empty box would open the rewind picker, so it is written only over text seen there.
- An interrupted long prompt (probed 2026-10-07, 2.1.287, `e2e/probes/interrupted-paste.e2e.ts`): a prompt interrupted before any reply comes back into the box as its text, never as a `[Pasted text #N …]` placeholder, whether 3, 6, 20 or 40 lines or one line of 300, 1200 or 2000 characters (the "paste again to expand" footer shows, but the box holds the words). A prompt taller than the box's viewport shows only its tail, so the box's text is not the whole prompt: the viewport was 7, 15 and 25 rows on screens of 24, 40 and 60 rows (`rows / 2 - 5`, `BoxProfile.viewport`), and 20 and 40 lines and 2000 characters (and 40 lines on 24 and 60 rows) each showed exactly that many rows, ending the prompt. `interrupt` takes as restored an exact match for the turn's own prompt, or the end of it in a box that tall; there is no placeholder clause, and a placeholder left in the box is `BOX_NOT_CLEARED`.
- Escape against a reply on its way (probed 2026-10-07, 2.1.287, `e2e/probes/interrupt-held-reply.e2e.ts`, 3 runs a case, terminals left open): a reply let go as `interrupt` resolves never drew (0 of 3 in every shape): `interrupt` resolves about 250 ms after the key, once it has cleared the prompt put back in the box. One let go together with a raw Escape drew (3 of 3), and in 10 of those 21 runs nothing says interrupted ("✻ Brewed for 1s · done"), the turn finished. 100 ms or more after it, never, but for one line of 300 characters, whose 1500 ms case errored in all 3 runs and 600 ms in 1 ("The prompt did not show in the agent's input box"), so that shape rests on fewer runs.
- What follows a raw Escape with the reply let go from 200 ms before it to together with it (probed 2026-10-07, 2.1.287, one-line prompt, each fact the runner's activity was told, 60 runs). The reply won 45 times: `Stop` (naming the reply) reached the runner before the key 36 times (up to 163 ms before it) and after it 9 times (2 to 58 ms), then `stop_hook_summary` 76 to 478 ms after it, no interruption record, "✻ … · done" on screen. The key won after the reply 15 times, with "Interrupted · What should Claude do instead?" under the reply: 14 fired `Stop` as well, each after the key, then the transcript's interruption record 197 to 517 ms after the key (its own timestamp 73 to 117 ms), and no `stop_hook_summary`; one fired no `Stop`. So `Stop` fires in both and tells nothing; the transcript's `stop_hook_summary` (finished) or interruption record (stopped) does, and no run had both. Once, in 10 runs of the chat's own `interrupt` with the reply let go 50 ms ahead, the key was stamped while the runner still held the turn working and the `Stop` hook had started 1 ms before it, which the activity's fence dropped as older than the Escape.
- Transcript saving is off when Claude Code inherits `CLAUDE_CODE_CHILD_SESSION`, as a process started from another Claude Code session does (probed: the TUI says so). Novadeck's shells must not pass that variable on, or the transcript fallback disappears.
- `claude agents --json` reports `busy`, `waiting` or `idle` per session and is documented as the supported way to read state from outside. It is a polled command, not a stream.

In the probe, a background subagent's result began a second turn with its own `UserPromptSubmit` and `Stop`. So a turn does not always start with the person typing.

- `Stop` lists `background_tasks`, each with its `type` (`subagent`, `shell` for a Bash command run in the background) and `status`. Once a running one finishes, Claude Code starts a turn by itself with a `<task-notification>` prompt, whose `Stop` lists what still runs; a background subagent and a background command each did (probed 2026-10-04, 2.1.289). A task that finishes while the turn still runs is handed back in a turn after its `Stop` too.
- Each time a root turn's Stop hooks run, the transcript gets a `{"type":"system","subtype":"stop_hook_summary"}` record, with `hookErrors` and `isSidechain: false`, whether Novadeck's hook ran or failed to (seen in 2.1.286 to 2.1.289 transcripts; one held "Failed to run: Plugin directory does not exist"). It is written once the hooks have finished, so after Novadeck's hook was answered. A Stop hook that blocks writes a `hook_blocking_error` attachment before it, and the turn goes on.

**Attention.**

- `PermissionRequest` fires as the prompt opens. It carries `tool_name`, `tool_input` and `permission_suggestions`, but no `tool_use_id` or request id.
- `PreToolUse` fires just before it with the `tool_use_id` (probed), but nothing ties the two, so Novadeck derives the request's id from the actor, the tool and a hash of the call's input, as the call's `PostToolUse` derives it too (see [Harness adapters](harness-adapters.md)).
- Approval shows only when the tool finishes, as that call's `PostToolUse` (probed): nothing fires between the approval and the result. While an approved long command runs, the request looks pending; `claude agents --json` reporting `busy` rather than `waiting` is the only other source (documented).
- A denial by the person fires nothing, not even `Stop` or `PostToolBatch` (probed interactively with every event registered). `PermissionDenied` covers auto mode only. The transcript records the call's `tool_result` with `is_error`, the interruption and `turn_duration`, so the transcript ends the request and the turn. An approved call interrupted with Esc leaves the same records, so the outcome stays unknown.
- A background subagent's request denied by the person, with Esc or its "No" key, fires no hook either, but the subagent gets the denial as the call's `tool_result` ("Permission for this tool use was denied…", in `subagents/agent-<id>.jsonl`) and runs on: here it answered and ended with `SubagentStop` (probed 2026-10-03, 2.1.287).
- In print mode (`-p`), where no one can answer, the denied call is instead listed in `PostToolBatch` with its `tool_use_id` (probed).
- Questions are the `AskUserQuestion` tool. It fires `PreToolUse`, then `PermissionRequest` like any tool (probed), so the question's kind comes from `tool_name`. Its `PostToolUse` carries `tool_response.answers`, keyed by question text (probed). MCP elicitations have `Elicitation` and `ElicitationResult` with an `elicitation_id`.
- `PermissionRequest`, `Elicitation` and `PreToolUse` can answer: a later `respond`/`answer` capability has a native path.
- A `PermissionRequest` hook runs alongside its dialog, not before it: the dialog draws at once, and whichever answers first wins, the hook's reply closing the dialog ("Allowed by PermissionRequest hook") even after the person picked part of a question. Claude Code doesn't kill the hook once the person answered. No output, or a timeout, leaves the dialog as it is (probed 2026-10-06, 2.1.287).
- What a hook decision does: deny with a message gives the call an `is_error` result and the turn goes on (`interrupt: true` ends it as Esc does); allow with `updatedInput` changes what runs; `updatedPermissions` `addRules` for the session sticks. `AskUserQuestion` takes its answers as allow with `updatedInput.answers`, keyed by question text, and a plain allow doesn't skip its dialog; `ExitPlanMode` skips its dialog only with allow and an `updatedInput` (`{}` is enough), a `setMode` update choosing the next mode (probed 2026-10-06, 2.1.287). Novadeck answers neither from hooks: the chat answers through the dialog's keys.
- Dialogs and their keys (probed 2026-10-06, 2.1.287): a permission offers `1 Yes`, a "don't ask again" option where the tool has one, and `No`; digits answer at once wherever the highlight is, Enter takes the highlighted row, Esc denies. At 60 columns an MCP tool's dialog drops its "don't ask again" option, so No moves from 3 to 2. `AskUserQuestion` numbers its options, then `Type something.` and `Chat about this`; a digit selects and moves on; with several questions a tab bar leads to a review screen (`1. Submit answers`, `2. Cancel`); multi-select toggles with digits or Space. Typed words go in only once `Type something.` shows focused: text typed right after its digit is lost. Where any option has a `preview`, digits only move the highlight. `ExitPlanMode` offers auto-accept edits, manually approve edits, and "Tell Claude what to change", a field for feedback; without a plan file it is the short "Exit plan mode?". A dialog taller than the screen scrolls its top away.
- `Elicitation` carries `{mcp_server_name, message, mode, requested_schema}`, with no `elicitation_id` in 2.1.287, and answers with `{action, content}`; `ElicitationResult` carries the `action` and `content` the person gave. Its form reads "MCP server “<server>” requests your input", the message, a row per field (`*` marks one required and unset, `✔` a valid one, `⚠` an invalid one with its message below), then `Accept` and `Decline`. Typing fills the highlighted text or number field, Down moves on, Space toggles a boolean (`☐`/`☒`), Right opens an enum and Space picks the highlighted choice; Down past the last field reaches Accept, Right Decline; Accept with a required field empty is refused. The form handles a key against the highlight it drew before its last redraw: Down then Space sent at once toggles the field left behind, and Enter on Accept sent at once is ignored, so a key must follow a moment of the screen holding still; a bracketed paste fills a text or number field as typed keys do (probed 2026-10-06, 2.1.287 and 2.1.291).
- Read outside the project asks: "Read file", `Read(<path>)` between rules, "Do you want to proceed?". Grep and Glob outside it don't ask; MultiEdit isn't a tool in 2.1.287 (probed 2026-10-06).
- An Edit's diff draws each leading tab as two spaces, a new file's rows as eight. An Edit with `replace_all` (drawn one hunk per occurrence) is never answered from the chat: its dialog can't show every occurrence. Claude Code normalises curly quotes when it matches an edit's old text, which the chat leaves to the terminal too, and matches leading tabs as two spaces, so a tab and two spaces are the same to it and to the chat. Trailing whitespace at the end of a line isn't drawn, so edits differing only in it read alike (probed 2026-10-07, 2.1.287 and 2.1.291). An Edit that replaces a text that doesn't end a line by nothing isn't answered from the chat either: Claude Code removes the line break too, while its dialog draws a blank row. Nor is an Edit whose change may reach the end of the file (fewer than three rows of context after it), or any file dialog that draws `No newline at end of file`. An Edit that only removes lines, or whose only added row is blank or the start of a removed row, is left to the terminal too: Claude Code draws a deletion that joins lines, and a replacement by nothing, the same way. Inside a wrapped line, a break with no space is read only where the row filled the screen's width. A row that fills the width exactly at a space can't be told from one broken inside a word, so two edits differing only by that space read alike. Written text is read only if it ends with a line break and no line ends in blanks: a blank row can't be told from a whitespace-only line, and text without a final line break draws as if it had one. A partial edit inside a line that wrapped onto several rows isn't read either: the wrapped row's text can't be told from its wrap.
- 2.1.291 draws every dialog above as 2.1.287 does: only the spinner, its verbs and timestamps differ (probed 2026-10-06). Channels (`claude/channel/permission`) relay permission requests too, but need `--channels` and weren't available in the e2e sandbox.

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

**Shell mode (`!`).** Probed 2026-10-07 (2.1.287; 2.1.291 the same) in the e2e sandbox.

- Entering: `!` as the first character of an empty prompt switches the box to shell mode, pasted with the rest or typed alone, and the footer reads "! for shell mode" (`box.ts` checks it against the box's `!` marker; `fixtures/shell-mode.probe.json`). Enter runs the command, then Claude Code makes a model call with its output in context. A multi-line paste runs as one script. A Backspace on the lone `!` leaves shell mode, idle or mid-turn.
- A trailing `@` or `$` opens no picker; the command runs as written.
- Mid-turn the command queues ("Press up to edit queued messages", "ctrl+x ctrl+s to send now") and runs once the turn ends.
- Esc on a command still running puts it back in the box; nothing further was recorded.
- The transcript records two user records, no tool call: `<bash-input>CMD</bash-input>`, then, with the first's `uuid` as its `parentUuid`, `<bash-stdout>OUT</bash-stdout><bash-stderr>ERR</bash-stderr>`. `OUT` is `(Bash completed with no output)` for none. Stderr of a command that succeeds is in stdout; a non-zero exit puts its output in stderr, and no exit code is recorded. Output is not truncated (4000 lines kept). Nothing marks the records but the tags; a command still running when probed (`sleep 30`) was preceded by an `isMeta` `<local-command-caveat>` record.

**Usage, limits, context.**

- **Transcript:** `assistant.message.usage` has input, output and cache counts. Several records can belong to one API response, so deduplicate by `requestId`.
- **Status line:** the JSON on stdin has
  - `cost.total_cost_usd` (a client-side estimate),
  - `context_window` (size, `used_percentage`, current usage),
  - `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` (0–100) and `resets_at` (epoch seconds),
  - `model.display_name`, and `effort.level` (`low` to `max`), which the statusline docs (https://code.claude.com/docs/en/statusline) say is absent for a model without an effort parameter; the probe fixture predates it.
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
- Its terminal title tells when its own prompt shows, before any `SessionStart`: given the items `status` and `thread-id` (`-c tui.terminal_title=['status','thread-id']`, as Novadeck's shim passes), it read "Ready | <the start of its thread's id>..." about 440 ms after its prompt drew, at a plain start, after `/clear` (the new thread's id, the one `SessionStart` names at the next prompt) and at `codex resume <id>`; "Working" during a turn, "Ready" after. It set no title at all while its folder-trust dialog, "Hooks need review" screen, sign-in screen, update screen ("Update available", from a newer version planted in `version.json`, killed without a key pressed) or the bare `codex resume` picker showed. The `thread` item shows the whole id only while the thread has no name, so `thread-id` it is. After Esc skipped the hooks review it said Ready with the hooks not running (probed 2026-10-01, 0.159.3).
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
- A spawned subagent's request (`multi_agent_v1`, under `--no-daemon`) shows in the root's TUI as "Thread: Agent (<id>)". Its `PermissionRequest` and, once allowed, its `PostToolUse` carry its `agent_id`, and its turn's end fires `SubagentStop`, not `Stop`. Esc on it closes the dialog and fires no hook at all, neither `Interrupt` nor `SubagentStop`: only the subagent's own rollout records `turn_aborted`, and the subagent stays open (probed 2026-10-03, 0.159.3). Novadeck follows that rollout while the subagent's request waits, and takes the abort as the end of that subagent's turn: its requests settle, and it still runs.
- Approvals are not written to the rollout.
- `request_user_input` runs only in Plan mode, or with `default_mode_request_user_input`; elsewhere the model is told it's unavailable. It fires `PreToolUse` (`tool_input.questions[{id, header, question, options}]`) and `PostToolUse` (`tool_response.answers`, by question id), never `PermissionRequest`; the rollout's pending `function_call` holds its questions. Its dialog numbers the options, adds "None of the above" with notes on Tab, and a digit answers one question (probed 2026-10-06, 0.159.3).
- A `PermissionRequest` hook runs before the approval dialog: while it waits the TUI shows only "Running hooks", keys go to the composer, and Esc interrupts the turn, killing the hook. Allow runs the call with no dialog; deny with a message lets the turn go on with the model told why, where the dialog's own No aborts the turn. No output, or a timeout, brings the dialog up unchanged; `updatedPermissions`, `updatedInput` and `interrupt` fail ("unsupported"), then the dialog shows. There is no approve-for-session from a hook. The default hook timeout is 600 s (probed 2026-10-06, 0.159.3).
- Dialogs and their keys (probed 2026-10-06, 0.159.3): an exec approval reads "Would you like to run the following command?" with `$ <command>`, an edit "Would you like to make the following edits?" with `Destination:`, each option ending in its key, `(y)`, `(p)` or `(a)`, `(esc)`; only offered options respond, and `[tui.keymap.approval]` can rebind them. An MCP tool's approval is a form, `1. Allow`, `2. Cancel`. After a plan, "Implement this plan?" offers implement, clear context and implement, or stay in Plan mode, firing no hook. MCP elicitation forms fire none either and live only on screen. Two calls asking at once queue, and the later one showed first. A key pressed with no dialog up lands in the composer.
- 0.160.1 draws every dialog above as 0.159.3 does, keys and result lines included; which of two parallel approvals shows first varied between runs, and the hooks came in the order shown (probed 2026-10-06).
- `PermissionRequest` can answer `allow` or `deny`.

**Actors.**

- `SubagentStart` and `SubagentStop` carry `agent_id` and `agent_type`, and `SubagentStop` adds `agent_transcript_path`.
- Each subagent has its own rollout whose `session_meta.source.subagent.thread_spawn` names the parent thread.
- Internal threads (`review`, `compact`, `guardian`, `memory_consolidation`) are not the person's agents.

**Transcripts.** The rollout is JSONL at `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`.

- Records are `session_meta`, `turn_context`, `event_msg` (`task_started`, `item_completed`, `token_count`, `task_complete`, `turn_aborted`, `context_compacted`, …), `response_item`, `token_usage_record`, `world_state` and `compacted`.
- Items appear only once completed (probed), so a running command is visible only through `PreToolUse`.
- The format is undocumented and changed recently (`history_mode`, `migrate-rollouts`).

**Planning.** Plan Mode is a collaboration mode, entered with `/plan` in the TUI. Hooks keep `permission_mode: default` in it (probed, 0.159.2). The rollout says it: each turn's `task_started` names `collaboration_mode_kind: plan` (written before the SessionStart hook that binds a session, so Novadeck reads the rollout's latest mode and plan when it starts following it), `turn_context.collaboration_mode.mode` is `plan`, and the proposed plan is an `item_completed` event whose item is `{type: "Plan", text}` (Markdown), also wrapped in `<proposed_plan>` in the assistant's message. The `update_plan` checklist tool the binary still documents was offered to the model in neither mode.

**Agent messages.** `response_item`s of type `agent_message` carry `author` and `recipient` agent paths (`/root`, `/root/<name>`) and content of `input_text` plus `encrypted_content`. Across 2,700 local rollouts, each holds only the messages its own agent received: a subagent's from its parent (or another agent), the root's from its subagents.

**Shell mode (`!`).** Probed 2026-10-07 (0.159.3; 0.160.1 the same) in the e2e sandbox.

- Entering: `!` as the first character of an empty prompt, pasted with the rest or typed alone, and the footer reads "Shell mode" (`box.ts` checks it against the box's `!` marker; `fixtures/shell-mode.probe.json`). Enter runs the command at once, with no model call. A multi-line paste runs as one script. A Backspace on the lone `!` leaves shell mode, idle or mid-turn.
- A trailing bare `@` or `$` opens the file or skill picker, and Enter then inserts its highlighted entry instead of running the command (`echo @` became `echo @novadeck`, `echo $` became `echo $imagegen`, and neither ran); a trailing `@src` opened the picker too but Enter ran it, and `$HOME` ran.
- Mid-turn it runs at once, while the turn works (footer "tab to queue message"), and is recorded after the turn's reply.
- Esc on a running command aborts it ("command aborted by user", exit code -1).
- The rollout records one user `message` whose text is `<user_shell_command>\n<command>\nCMD\n</command>\n<result>\nExit code: N\nDuration: X seconds\nOutput:\nOUT\n</result>\n</user_shell_command>`, stdout and stderr merged in `OUT`, truncated by Codex (with a "Warning: truncated output" line) for long output. An `event_msg` `item_completed` `CommandExecution` with `source: "user_shell"` records it too, with stdout, stderr and the exit code apart; a model's command is a `function_call` instead.

**Usage, limits, context.** The rollout's `token_count` holds:

- `info.total_token_usage` (cumulative for the thread) and `info.last_token_usage` (the latest response): input, cached, cache write, output, reasoning and total tokens.
- `info.model_context_window`.
- `turn_context` (a separate rollout record, one per turn) names the turn's `model` and `effort` (probed).
- `rate_limits.primary` and `rate_limits.secondary`, each with `used_percent` (0–100, probed), `window_minutes` and `resets_at` (epoch seconds, probed). `secondary` can be null.

Other facts:

- `token_usage_record` gives usage per response and per turn.
- No source reports a cost.
- Occupancy is estimated from the last response's input tokens over `model_context_window`.
- Esc during a turn before any reply leaves the prompt, single or multi-line, echoed above the box with "■ Conversation interrupted" under it, and the box empty (probed 2026-10-06, 0.159.3, the e2e sandbox with the fake model).
- Its input box has no frame: `› ` leads its first row, the rest are indented, the cursor is on the last row, a blank row and its status line (`fake-model default · <dir>`) below. Empty it shows `› Ask Codex to do anything`, the suggestion drawn dim; the first key changes the welcome screen (logo and all) to the history-less layout, and a turn's "Working" row sits above the box, not between its rows. Pastes show whole up to 30 lines (the box grows to them), and over 1,000 characters (1,000 showed, 1,024 did not) as `› [Pasted Content 1030 chars]`, however many lines; text pasted after that follows on the next row. The box may take the screen's rows less 3 (the blank row, status line and hints below it). Mid-turn the box and its draft are drawn the same, its footer reading "tab to queue message" Indented lines, a tab (drawn as spaces) and blank lines show as rows, all of them indented at least two columns under the marker; a ZWJ family emoji drew blank (probed 2026-10-07, 0.159.3 and 0.160.1, `e2e/probes/input-box.e2e.ts`, fixtures/input-box.probe.json).
- Queued messages and Escape (probed 2026-10-07, 0.159.3 and 0.160.1): a prompt given mid-turn shows as "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)" with the words under it, and the box stays empty. One Escape sends it as a steer ("Model interrupted to submit steer instructions", the words echoed as the next turn), which goes on working; a second Escape stops that turn ("■ Conversation interrupted"). Nothing comes back into the box, so there is nothing to clear and no words to give back.
- An interrupted long prompt (probed 2026-10-07, 0.159.3, `e2e/probes/interrupted-paste.e2e.ts`): after Escape the box reads empty for 3, 6 and 20 lines and one line of 300, 1200 and 2000 characters (40 lines is refused by the box's room), so no placeholder comes back.
- Escape against a reply on its way (probed 2026-10-07, 0.159.3, `e2e/probes/interrupt-held-reply.e2e.ts`, 3 runs a case, terminals left open): Codex too takes the key a moment after it is written. A reply let go the instant `interrupt` resolved, 1500 ms into the model call, drew in 2 of 3 runs for one line of 2000 characters (0 of 3 at 0 ms into the call, and in every other shape). Let go 100 ms or more after a raw Escape it never drew, with "■ Conversation interrupted" on screen, but for one run (2000 characters, 300 ms) whose screen still read "Working (… esc to interrupt)" after 8 s, the key not yet taken under load. 40 lines is refused by the box's room.
- What follows a raw Escape with the reply let go from 200 ms before it to 300 ms after (probed 2026-10-07, 0.159.3, one-line prompt, each fact the runner's activity was told, 142 runs). The reply won 30 times, all with the reply let go 50 ms or more before the key: `Stop` (naming the reply) reached the runner before the key every time (up to 371 ms before it), the rollout's `task_complete` 9 to 404 ms after the key, no `Interrupt`, no "Conversation interrupted". The key won 112 times, each with `Interrupt` 11 to 171 ms after it and `turn_aborted` 22 to 644 ms; in 35 of them `Stop` fired first (20 reaching the runner before the key, 15 after), the reply drawn above "■ Conversation interrupted". So Codex's `Stop` fires in both and tells nothing; `Interrupt` and the rollout's two records do. In none of the 30 lost runs was the key stamped before the runner had `Stop` (the hook names the reply, so it is told without a transcript read), so Codex reaches the Escape race only as a completed end, before the key or just after it, that an `Interrupt` then turns interrupted: the runner shows the first as finished until the interruption comes.

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
- A subagent from `invoke_subagent` runs on after the root's `Stop` (`fullyIdle: false`), and its end wakes the root the same way. The status line lists it under `subagents` (`{name, role, status}`, `running` then `completed`), but never lists a command it backgrounded (probed 2026-10-04, 1.2.14). The list is on `working` snapshots too, not only `idle` ones: a live interactive session whose root started two subagents saw `idle` `[]`, `working` `[]`, then `working` with one and two `running`, one `completed`, the root's `Stop` (`fullyIdle: false`) and an `idle` still listing one `running`, a `working` wake turn with it still `running`, then both `completed` and `idle` (71 snapshots, 1.2.16, probed 2026-10-07). The list's order flips between snapshots, so count by `status`, never position, and a `completed` entry stays listed. Print mode (`agy -p`) never leaves `initializing`, so it shows none of this.

**Attention.**

- There is no permission hook. Whether a confirmation shows depends on the person's policy, so `PreToolUse` alone does not mean one is open.
- The status line's `tool_confirmation_pending` says a confirmation dialog is open, without naming the step. With the preceding `PreToolUse`, it identifies the request.
- The confirmation offers yes, yes for this conversation, yes persisted, and no. Approval shows as `PostToolUse` for the step; a denial ends the turn silently.
- `ask_question` fires `PreToolUse` (`toolCall.args.questions[{question, options, is_multi_select}]`) and `PostToolUse`, but the status line stays `working` with no `tool_confirmation_pending`, so only the hook tells it. Its dialog numbers the options, then `Write-in...`; Esc skips. Its result step reads `A1: <choice>`, or `A1: User Skipped` (probed 2026-10-06, 1.2.14).
- A `PreToolUse` hook that waits hides the dialog behind a spinner, and the person's keys go to the prompt box. `allow` doesn't skip a confirmation, with or without `permissionOverrides`; `ask` shows it; `deny`, `{}` or no decision deny the call, its reason in the step's error; a hook killed at its timeout fails the call (probed 2026-10-06, 1.2.14).
- Dialogs and their keys (probed 2026-10-06, 1.2.14): a command shows "Run this command?" with `1. Yes, run command`, two "always allow" options and `4. No, cancel`; a file write "Allow creation of this file?" with two; digits act at once, Esc cancels, and a long command is cut after five lines at 60 columns. A denial writes a step with the error. A plan that asks for feedback isn't a dialog: the status line says `reviewing`, and `/artifact` lists it for `y` or `n`, which start a turn with "[Approved]" or "[Rejected]".
- 1.3.0 draws every dialog above as 1.2.14 does; its history lines now read like `● Ran (echo approved)`, folding queued calls (`● Ran 2 commands (…)`), and a `PreToolUse` answer of `{}` no longer denies (probed 2026-10-06; Novadeck's answer stays `ask`).

**Actors.** Subagents are separate conversations. Hooks do not say whether they fire for them. `conversation_summaries.db` records `parent_conversation_id` and `nesting_depth`.

**Transcripts.** Every hook names the transcript, `transcript_full.jsonl` under `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/` (probed, 1.2.13); `transcript.jsonl` beside it holds the same records with long fields truncated. Each line is a step: `step_index`, `source` (`USER_EXPLICIT`, `MODEL`, `SYSTEM`), `type` (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `SYSTEM_MESSAGE`), `created_at`, `content`, and on a model response `thinking` and `tool_calls` (`{name, args}`, no id). A result step's `status` is `DONE`, `ERROR`, or `RUNNING` for a command still running; whether a finished one is appended again is unprobed (no local transcript repeats a step). A tool call's result is the `GENERIC` step as many steps on as its place in the call list, plus one: three calls made at once in step 1 got their results as steps 2, 3 and 4, a failed call included (probed). Lines are not in step order: results made at once can be written before the step that made the calls. The person's input wraps their words in `<USER_REQUEST>`, followed by context blocks (`ADDITIONAL_METADATA`, `PLAN`, …). Compaction is internal: the binary has a trajectory compaction and an `ON_COMPACTION` lifecycle hook, but no command a person can run (`/compact` is not a slash command in print mode or the TUI; typed, it reaches the model as text). So a rewrite on compaction stays unprobed short of filling the context; through the probes (1.2.13 and 1.2.14) the file was only ever appended to, keeping its inode. Novadeck's reader resets on a file that shrinks or is replaced, should compaction rewrite it.

**Plans.** In plan mode (`--mode plan` or `/plan`) the agent writes its plan with `write_to_file` as an artifact, `implementation_plan.md` in the conversation's `brain` folder, whose `ArtifactMetadata.RequestFeedback` is true; a walkthrough after implementing does not ask for feedback. Both sit in the folder hooks name as `artifactDirectoryPath`, the conversation's own. PreToolUse and PostToolUse both fire with `toolCall: {name, args}` and `error` (probed), so Novadeck's plugin registers PostToolUse for `write_to_file` only, answered with `{}`. The status line names the conversation but not its transcript; a later hook does.

**Planning.** Plan mode exists (`--mode plan`, `/plan`), and the status line reports `cycle_mode`: `plan` or `accept-edits`, absent in the default mode (probed with `--mode`). Plans, task lists and walkthroughs are artifacts under `artifactDirectoryPath`. No signal marks a plan's approval.

**Shell mode (`!`).** Probed 2026-10-07 (1.2.14) in the e2e sandbox.

- Entering: only a `!` typed alone switches to shell mode (footer "activated bash mode · esc to cancel", which `box.ts` checks against the box's `!` marker; `fixtures/shell-mode.probe.json`, 1.2.14 and 1.3.0); the rest can then be pasted, one or several lines. A paste it shows as a placeholder ("[Pasted text #1 1516 chars]", "[Pasted text #1 +16 lines]"; 900 characters and 8 lines still showed in full) runs as that text, not the command (`/bin/bash: line 1: [Pasted: command not found`), so `BoxProfile.shell.expands` is false. A Backspace on the lone `!` leaves shell mode, idle or mid-turn. A prompt pasted whole with the `!` first is no shell command: it goes to the model as the prompt, `!` included.
- Mid-turn the command queues ("Press up to edit queued messages") and runs after the turn.
- The transcript records nothing of a shell command, nor its output; only the prompt's history (`history.jsonl`) lists it, with `"type": "shell"`.

**Usage, limits, context.** The status line only. Its JSON on stdin has:

- `agent_state` (`idle`, `thinking`, `working`, `tool_use`, `initializing`),
- `context_window` (size, used percentage, token totals),
- `quota` per model (`remaining_fraction`, `reset_time`, `reset_in_seconds`),
- `cost`, `task_count` and `pending_input_count`.

The model is not in it: every hook's `modelName` names it, as `gemini-3.8-flash-high`. Novadeck reads a trailing `minimal`, `low`, `medium`, `high` or `xhigh` as the reasoning effort, an inference from the names seen.

It also carries the account's `email`, which must not leave the adapter.

- Esc during a turn before any reply leaves the prompt, single or multi-line, echoed above the box with "⎿ Interrupted · What should Antigravity CLI do instead?" under it, and the box empty (probed 2026-10-06, 1.2.14, the e2e sandbox with the fake model).
- Its input box is between two `─` rules, `> ` leading its first row and the rest indented, the cursor on the last row; its history above echoes the person's turns the same way, rules included, so only the lowest pair is the box. Empty it shows `>` alone. A paste of 15 lines shows whole (even of 100 characters each), 16 or more show `[Pasted text #3 +25 lines]`, and one line of over 1,000 characters (1,000 showed, 1,024 did not) `[Pasted text #4 1499 chars]`. Its box may take the screen's rows less 4. Mid-turn the box is below the spinner row, drawn the same (probed 2026-10-07, 1.2.14 and 1.3.1, `e2e/probes/input-box.e2e.ts`, fixtures/input-box.probe.json).
- Queued messages and Escape (probed 2026-10-07, 1.2.14 and 1.3.1): a prompt given mid-turn shows above the box ("▸ Queued beta") with "Press up to edit queued messages" below it. One Escape stops the turn ("Interrupted · What should Antigravity CLI do instead?") and puts the queued messages in the box, one to a line (two queued: `Queued beta`, `Queued gamma`); a second or third Escape changes nothing. Ctrl-U clears the cursor's line and Backspace joins the line before it, so `Ctrl-U Backspace` per extra line, then Ctrl-U, clears them; Escape twice at once, after the turn has stopped, left the box empty as well.
- An interrupted long prompt (probed 2026-10-07, 1.2.14, `e2e/probes/interrupted-paste.e2e.ts`): after Escape the box reads empty for 3, 6, 20 and 40 lines and one line of 300, 1200 and 2000 characters, so no placeholder comes back.
- Escape against a reply on its way (probed 2026-10-07, 1.2.14, `e2e/probes/interrupt-held-reply.e2e.ts`, 3 runs a case, each run's terminal left open, so later cases ran under more load): Antigravity takes the key a moment after it is written. A model reply let go the instant `interrupt` resolves wins the race in every shape (1, 3, 10, 25 and 40 lines, one line of 300 or 2000 characters; 3 of 3 each): the reply draws, and in nearly all of those runs (38 of 42; 19 of 21 where it was let go together with a raw Escape) no "Interrupted" line shows, the turn simply finished. Let go 100 ms or more after a raw Escape, it never drew (0 of 3 in every shape), and the screen shows "⎿ Interrupted · What should Antigravity CLI do instead?". A test that holds a reply lets it go only once that "Interrupted" line shows.
- What follows a raw Escape with the reply let go from 200 ms before it to 300 ms after (probed 2026-10-07, 1.2.14, one-line prompt, each fact the runner's activity was told, 100 runs). The reply won 64 times: `Stop` (naming no reply, `terminationReason` `NO_TOOL_CALL`) reached the runner before the key 21 times (up to 179 ms before it) and after it 43 times (2 to 173 ms), then an idle status line, and no "Interrupted" line. The key won 36 times: no `Stop`, no hook at all, only the idle status line about 65 ms and 365 ms after the key, the same idle it reads after a `Stop`, so it says nothing of how the turn ended. Antigravity's `Stop` therefore fires only for a turn that finished, and is the one signal that the reply won. With the reply let go together with the key, the `Stop` reached the runner after it every time (8 of 8).
- What the runner does with them: the Escape ends the turn interrupted at once, as before. A harness's own word then decides (`Harness.records`, `escapeVerdictMs`, docs/agent-messaging.md): Claude Code's `stop_hook_summary` or Codex's `task_complete` settles it completed at once (with the reply the held `Stop` named); Claude Code's interruption record, Codex's `Interrupt` or `turn_aborted` keep it interrupted, whatever `Stop` came first; a `Stop` with neither within 1.5 s of the key stands as the end; Antigravity's `Stop` is the end at once; with nothing within the window the turn stays interrupted. Before this, a `Stop` that fired as the key was taken (Claude Code, Codex) read completed until the interruption record replaced it, a false finish notification for a turn the person stopped, and a Stop that started before the runner stamped the key was dropped, leaving a finished turn reading interrupted. A turn taken as completed is still corrected to interrupted by the harness's record of the interruption within the window, and a Stop that reached the runner before the key (Codex's, most often) is a plain finish the interruption then replaces, so the client holds a finish for `finishGraceMs` (700 ms) and drops it should the same turn's end turn interrupted meanwhile.

## Consequences for the design

1. **A status line bridge is the only route to some features.** It is the only live source for:
   - Claude Code's rate limits and context occupancy,
   - Antigravity's agent state, attention, usage, limits and context.

   A status line is a single user-level setting. For feature parity Novadeck installs a bridge command that forwards to the person's own status line command, so their status line keeps working. For Claude Code, Novadeck's shells can pass `--settings` at launch, as the Codex shim does for its flag, so the bridge applies only to Novadeck's terminals. See [the design](harness-adapters.md#native-sources).

2. **Permissions have no request ids, and approval is seen only at completion.** A request's id is derived from its actor, its tool and a hash of the call's input, which the call's `PostToolUse` derives too; Antigravity's one confirmation at a time is the fixed `confirmation` (see [Harness adapters](harness-adapters.md)). A matching `PostToolUse` means allowed, but it fires when the tool finishes, so an approved long command keeps its request looking pending. Claude Code's `claude agents --json` (`busy` versus `waiting`) and Antigravity's `tool_confirmation_pending` can close that gap; Codex exposes approval state only through its app-server.
   - A denial fires nothing in Claude Code and Antigravity. Claude Code's transcript records an interruption, which an approved call interrupted with Esc also leaves, so it ends the request without saying which.
   - A denial fires `Interrupt` in Codex.
   - Otherwise the actor moving on resolves the request with an `unknown` outcome: the root's next turn start or end, or a subagent's stop or its turn's abort. A subagent's next request or its result for another call does not, and one answered with no report waits until its subagent stops (see [Harness adapters](harness-adapters.md) for the per-actor rules).
3. **Novadeck's Antigravity hook must answer `PreToolUse` with `{"decision": "ask"}`.** An empty answer denies every tool.
4. **Interruption is harness-specific.**
   - Codex fires `Interrupt`.
   - Claude Code fires nothing; its transcript records the interruption and the turn's end.
   - Antigravity fires nothing, and its transcript drops the cancelled steps. Its status line's `agent_state` returning to `idle` is the remaining signal; a probe saw it after a denied confirmation.

   Without such a source, a turn stays `working` until the next event, and coverage says so.

   An Escape can lose to a reply on its way in all three, and each says how the turn ended its own way: Claude Code by `stop_hook_summary` against its interruption record, Codex by `task_complete` against `Interrupt`, Antigravity by its `Stop` against nothing.

5. **Every harness identifies its instance through the hook's process ancestry.**
   - Claude Code sets `CLAUDE_PID`.
   - A Codex hook's parent is `codex`.
   - An Antigravity hook's grandparent, through `sh`, is `agy`.

   The hook host should report the nearest ancestor whose executable is the harness, found through its `programs`. That gives `same-root-instance` evidence for all three, so Antigravity's `conversation-observed` switching can tighten. Linux was probed; macOS and Windows need their own process lookup. Inherited environment variables cannot stand in for it.

6. **Limits are percentages, not token counts.** Every harness reports windows as a used or remaining fraction with an absolute reset instant: Claude Code and Codex in epoch seconds, Antigravity as a time. None reports the limit itself, so the telemetry model stores fractions and never derives token amounts.
7. **Codex hook trust is a separate readiness state.** A connected Codex with untrusted hooks reports nothing. Detecting that needs the app-server's `hooks/list`, not a hook.
8. **One installed plugin serves every Novadeck build.** Each harness keeps one copy of Novadeck's plugin per user, from whichever build connected it last, so a terminal's own runner names what it starts. Hooks run `$NOVADECK_HOOK`, and on Linux and macOS the MCP server the launcher in `NOVADECK_MCP`, both set by the terminal's own runner, with the connecting build's launcher as the MCP server's fallback outside Novadeck; on Windows it is the connecting build's relay, which still carries the agent's messages to the terminal's own runner (see [harness adapters](harness-adapters.md#local-mcp)). Each harness starts an MCP server's command without a shell. Claude Code and Antigravity give it the agent's environment, and Codex only the variables `env_vars` lists (probed in the e2e suite, `messaging.e2e.ts`). Claude Code expands `${VAR}` and `${VAR:-default}` in an MCP configuration itself (documented), so the command holds neither.

## Working past a turn's end

An agent works, as Novadeck shows it, while its turn runs, and after the turn while
subagents it started run on, which wake it once done: Working ends only once its own
turn has ended and no subagent of it still runs. Other work a turn leaves running, as a
command run in the background, shows as left running (a badge, "1 task"), but keeps
nothing working: a dev server, a watcher or `tail -f` may run for ever. `wakes` on each
harness says whether anything wakes it. Antigravity's status line counts its running subagents while the turn runs too, so they show as left running mid-turn and through a wake turn, where Claude Code's and Codex's show only once the turn has ended.

| Harness     | What a turn leaves running                                                                                       | How Novadeck counts it                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Background subagents and commands, listed by `Stop`, each waking it once done                                    | `Stop`'s running `background_tasks`: `subagent` ones as agents, which keep it working, the rest as tasks, which don't; where no `Stop` says, its running subagents                                                                                                |
| Codex       | Nothing that wakes it: its subagents and commands finish with the root idle                                      | Never waits: its turn's end is the end of Working                                                                                                                                                                                                                 |
| Antigravity | Subagents and backgrounded commands, which `Stop` says only exist (`fullyIdle: false`), each waking it once done | While the turn runs, its working status line's running `subagents`, shown as `background`; after `Stop`, working until its next idle status line counts them, then only while it counts one; what else `Stop` said runs shows as background work, keeping nothing |

The wait ends with the turn the work's end starts, at that turn's own end with nothing
running, or with any later turn, as the person's. Antigravity's idle status line
listing no subagent running ends it too, leaving any command it backgrounded shown but
not waited on. Codex's parity gap is the harness's own: nothing there wakes, so nothing
is waited on. Delivery waits the same way, so the doorbell may ring an agent with only a
command left running, and `agents` calls it busy only while it works.

A Stop Novadeck continues with messages keeps the turn running until the continuation's
own Stop, as Claude Code and Codex start the continuation with no prompt hook. Should its
hook never acknowledge the messages, the lease lapses and the turn ends at that Stop
after all.

A turn's end its hook never reported (Novadeck's hook failed to run, or a Codex turn
failed, which fires none) comes from the session's own records: Claude Code's
`stop_hook_summary`, Codex's `task_complete` or `turn_aborted` for the running turn's id,
and Antigravity's idle status line. Such a record ends only the turn still running, its
continuation included, and leaves the hook's own `Stop`, should it arrive after all, to
say what still runs. Claude Code writes one for a Stop Novadeck continued too, once its
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

After the person's Escape the turn reads interrupted at once, and its harness may still say it finished: a reply that reached it first completes the turn, and Claude Code and Codex fire their `Stop` for a turn they took the key just after the reply of too. The runner takes `completed` and the reply for the turn only from the harness's own record of the finish (`stop_hook_summary`, `task_complete`), or from a `Stop` that no interruption followed within `escapeVerdictMs`; Antigravity's `Stop` alone is enough, as it fires for no stopped turn (see each harness's "Escape against a reply on its way").

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

- Claude Code: NotebookEdit's permission dialog, elicitation with `enumNames`, URL mode or fields past the screen's fold; plan mode entered with Shift+Tab mid-session, which of `StopFailure` and the transcript ends a failed turn (one the API refused ended, 2026-10-04), subagent interruption, and the `agent_type` internal agents report.
- Codex: whether internal threads fire `SubagentStart`; network approvals; a subagent's approval dialog.
- Windows: Novadeck registers no PreToolUse hook for Antigravity until a Windows probe shows its command can't deny tools, so `ask_question` isn't detected there, and its command and file confirmations carry no tool input, which shows them raw; a hook launcher path with spaces isn't supported in any agent's `cmd` command.
- Antigravity: subagent hooks, the status line after an Esc, and compaction's rewrite of the transcript.
- The status line bridge in a live Novadeck terminal, for Claude Code and Antigravity.
- macOS and Windows: the hook's process ancestry, and every probe above.
