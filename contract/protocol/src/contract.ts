import { columns, rows, sequence } from "@novadeck/terminal"
import { wireContract, wireErrors } from "@novadeck/wire"
import { eventIterator, oc, type ContractRouterClient } from "@orpc/contract"
import { z } from "zod"

import {
  maxVoicePartLength,
  murmurSettings,
  murmurState,
  voiceChange,
  voiceState,
  voiceTranscript,
  voiceUnavailable,
} from "./addons.js"
import {
  agentDetail,
  agentIntegration,
  agentName,
  agentRef,
  conflictReason,
  interruptResult,
} from "./agents.js"
import {
  companionChange,
  companionItem,
  companionWindow,
  itemContent,
  maxPageTroubles,
  pageLook,
  pageLookAnswer,
  pageTrouble,
  planSaveResult,
  planUnwritable,
} from "./companions.js"
import { requestAnswer } from "./dialogs.js"
import { feedbackDraft, maxFeedbackText } from "./feedback.js"
import { directory, id, name } from "./fields.js"
import { askAnswer, inboxEntry } from "./inbox.js"
import { terminalMessages, threadId } from "./messages.js"
import { clientState, folderListing, project, workspaceSession } from "./projects.js"
import { runnerSettings, runnerSettingsState } from "./settings.js"
import {
  approval,
  approvalAnswer,
  maxUploadPartLength,
  startupCommand,
  terminalAttached,
  terminalChange,
  terminalEvent,
  terminalRequest,
  terminalRequestAnswer,
  terminalSummary,
  terminalTitle,
} from "./terminals.js"
import { transcriptChange } from "./transcripts.js"

export const errors = {
  ...wireErrors,
  // The workspace database was written by a newer Novadeck, which this runner cannot open.
  WORKSPACE_TOO_NEW: { status: 409 },
  NOT_FOUND: { status: 404 },
  INVALID_DIRECTORY: { status: 400 },
  INVALID_FILE: { status: 400 },
  // Optional data says why, for typing into an agent's terminal (`conflictReason`).
  CONFLICT: { status: 409, data: conflictReason.optional() },
  // A plan can't be written, and why (`planUnwritable`): saving it again won't help.
  PLAN_UNWRITABLE: { status: 409, data: planUnwritable },
  TERMINAL_LIMIT: { status: 429 },
  TERMINAL_NOT_FOUND: { status: 404 },
  TERMINAL_EXITED: { status: 409 },
  CONTROL_IN_USE: { status: 409 },
  CONTROL_REQUIRED: { status: 403 },
  ALREADY_ATTACHED: { status: 409 },
  SNAPSHOT_TOO_LARGE: { status: 413 },
  UPLOAD_TOO_LARGE: { status: 413 },
  SPAWN_FAILED: { status: 500 },
  AGENT_SETUP_FAILED: { status: 500 },
  PROMPT_FAILED: { status: 409 },
  // A prompt a TUI would read as more than text (`promptRefusal`): a control character, a
  // command (a leading `/` or `!`) or a file or skill mention left open at its end (`@name`,
  // `$name`); or one of nothing but white space. Nothing is written. Words that follow an
  // answer as a prompt are judged alike, before any key of the answer is pressed.
  PROMPT_REFUSED: { status: 409 },
  // The turn was stopped, but the agent's input box holds text (the person's queued
  // messages, put back by the Escape) that could not be cleared out with certainty.
  BOX_NOT_CLEARED: { status: 409 },
  ANSWER_FAILED: { status: 409 },
  // An answer took, but the words that follow it (as the agent's next prompt) did not.
  WORDS_NOT_SENT: { status: 409 },
  DIALOG_CHANGED: { status: 409 },
  VOICE_UNAVAILABLE: { status: 409, data: voiceUnavailable },
  VOICE_FAILED: { status: 500 },
}

const procedure = oc.errors(errors)

export const contract = {
  // The handshake, which opens every connection and names the runner's lifetime as its epoch.
  ...wireContract,
  projects: {
    list: procedure.input(z.void()).output(z.array(project)),
    // The client names the project before the runner answers; a taken id is a
    // CONFLICT. Without `cwd`, the project opens in the runner owner's home directory.
    create: procedure
      .input(z.strictObject({ id, name, cwd: directory.optional() }))
      .output(project),
    rename: procedure.input(z.strictObject({ projectId: id, name })).output(project),
    // Keeps how the person arranged the switcher: `order` by id, first to last, and the
    // ones pinned, at most nine, the first in `order` (one `order` doesn't name isn't
    // pinned). Ids it doesn't have are ignored;
    // projects `order` leaves out follow, in the order they were added.
    arrange: procedure
      .input(
        z.strictObject({
          order: z.array(id).max(1000),
          pinned: z.array(id).max(1000),
        }),
      )
      .output(z.void()),
    // Closes every terminal of the project's sessions, as `terminals.close` does but
    // whichever connection controls them, then forgets the project, its sessions and its
    // agents' messages; its folder stays. A project the runner doesn't have, as one
    // removed already, is NOT_FOUND.
    remove: procedure.input(z.strictObject({ projectId: id })).output(z.void()),
    // One folder of the project's directory as it is now, named by its path from the
    // project's root with `/` between names ("" for the root). The entries are sorted,
    // folders first; git's own `.git` is never among them. A project the runner doesn't
    // have is NOT_FOUND; a folder that is missing, no folder, or outside the project's
    // directory is INVALID_DIRECTORY.
    folder: procedure
      .input(z.strictObject({ projectId: id, folder: z.string().max(4096) }))
      .output(folderListing),
  },
  sessions: {
    list: procedure.input(z.strictObject({ projectId: id })).output(z.array(workspaceSession)),
    create: procedure.input(z.strictObject({ id, projectId: id, name })).output(workspaceSession),
    rename: procedure.input(z.strictObject({ sessionId: id, name })).output(workspaceSession),
    // Replaces the session's client state, which the runner stores without reading it, and
    // when the person last visited the session (null: never).
    save: procedure
      .input(
        z.strictObject({ sessionId: id, state: clientState, visitedAt: z.number().nullable() }),
      )
      .output(z.void()),
  },
  terminals: {
    // Every terminal of the session, running or saved to restore, oldest first.
    list: procedure.input(z.strictObject({ sessionId: id })).output(z.array(terminalSummary)),
    // `restore` starts where the runner's saved record of this terminal left off: in its
    // last directory, showing its saved transcript before the shell's output. `resume`
    // names the agent that ran there: while it is connected, the runner resumes the
    // session it last reported in this terminal, instead of showing the transcript.
    // A session resumes in one terminal only, never beside another terminal running it.
    // `command` runs once at the new shell's first prompt, as if typed there; a shell
    // that can't run one, as without Novadeck's shell integration, is SPAWN_FAILED. A
    // command goes with neither `restore` nor `resume`. A terminal closed in the runner's
    // lifetime, or one in a project being removed, is TERMINAL_NOT_FOUND: closed for good.
    create: procedure
      .input(
        z
          .strictObject({
            id,
            sessionId: id,
            cwd: directory.optional(),
            cols: columns,
            rows,
            restore: z.boolean().optional(),
            resume: agentName.optional(),
            command: startupCommand.optional(),
            // Its title, the person's; a restored terminal keeps its saved one, and a new
            // one takes the session's next default, when left out.
            title: terminalTitle.optional(),
            // The agent's request this terminal answers (`requests`): it takes the title
            // that agent asked for, as the agent's.
            requestId: id.optional(),
          })
          .refine(({ command, restore, resume }) => !command || (!restore && !resume), {
            message: "A terminal either starts a command or restores what it ran, not both.",
          }),
      )
      .output(terminalSummary),
    // Agents' requests for a new terminal, made through Novadeck's MCP server, for the
    // client to open where it lays terminals out. The runner sends each to the client
    // that subscribed last and waits a few seconds for its `answerRequest`.
    requests: procedure.input(z.void()).output(eventIterator(terminalRequest)),
    // Answers a request with the terminal the client opened for it, or why it didn't.
    // One the runner no longer waits for, or sent to another client, is NOT_FOUND.
    answerRequest: procedure.input(terminalRequestAnswer).output(z.void()),
    // Agents' requests to close a terminal that runs an agent they don't lead, or to lead one,
    // for the client to approve with the person: each goes to the client that subscribed
    // last, and waits for its `answerApproval`, with no time limit, until the runner
    // withdraws it.
    approvals: procedure.input(z.void()).output(eventIterator(approval)),
    // The person's answer to an approval. One the runner no longer waits for, or sent to
    // another client, is NOT_FOUND.
    answerApproval: procedure.input(approvalAnswer).output(z.void()),
    // The person ends a terminal's lead: its agent's messages are a peer's from then on,
    // and the teammate and the former lead are told. A terminal with no lead is a no-op;
    // one not there is TERMINAL_NOT_FOUND.
    release: procedure.input(z.strictObject({ terminalId: id })).output(z.void()),
    // Every terminal across sessions, running or saved: `changed` for each, `synced`, then
    // later changes (creation, title, size, foreground process, exit, restart, and its
    // shell's record let go, when it is saved again) and `removed` once it is closed.
    watch: procedure.input(z.void()).output(eventIterator(terminalChange)),
    attach: procedure
      .input(
        z.strictObject({
          terminalId: id,
          afterSequence: sequence.optional(),
          mode: z.enum(["control", "observe"]).optional(),
        }),
      )
      .output(eventIterator(z.union([terminalAttached, terminalEvent]))),
    write: procedure
      .input(z.strictObject({ terminalId: id, data: z.string().min(1).max(16_384) }))
      .output(z.void()),
    resize: procedure
      .input(z.strictObject({ terminalId: id, cols: columns, rows }))
      .output(z.void()),
    ack: procedure.input(z.strictObject({ terminalId: id, sequence })).output(z.void()),
    close: procedure.input(z.strictObject({ terminalId: id })).output(z.void()),
    // Renames a terminal: the runner keeps the title with the terminal, running or saved
    // to restore, and announces it on `watch`. One it keeps nothing of is
    // TERMINAL_NOT_FOUND; a new terminal takes its first title with `create`, or the
    // session's next default.
    rename: procedure
      .input(z.strictObject({ terminalId: id, title: terminalTitle }))
      .output(z.void()),
    // Hands a terminal's title back to Novadeck: the title the person gave it goes, and it
    // takes murmur's latest, else the one the agent that opened it gave, or its
    // default, as `rename` does announcing it. TERMINAL_NOT_FOUND as for `rename`.
    resetTitle: procedure.input(z.strictObject({ terminalId: id })).output(z.void()),
    // Saves a file pasted into a terminal in a folder of its own on the runner's machine,
    // for the terminal's programs to read at the absolute `path` it answers; uploads go a
    // week later. The file comes base64 in parts: one with `name`
    // starts it, and one with the `path` an earlier part answered adds to it. A file past
    // `maxUploadBytes` is UPLOAD_TOO_LARGE and goes, a `path` the runner isn't receiving
    // is NOT_FOUND, and a terminal it keeps nothing of TERMINAL_NOT_FOUND.
    upload: procedure
      .input(
        z
          .strictObject({
            terminalId: id,
            name: z.string().min(1).max(255).optional(),
            path: directory.optional(),
            data: z.base64().max(maxUploadPartLength),
          })
          .refine((part) => (part.name === undefined) !== (part.path === undefined), {
            message: "A part either starts a file by its name or adds to one by its path.",
          }),
      )
      .output(z.strictObject({ path: directory })),
    // Starts a fresh shell in an exited terminal, keeping its id, session and cwd; the
    // caller gains control. A running terminal is a CONFLICT. The earlier shell's screen
    // shows above the new one's, unless `resume` resumes an agent session, as for create.
    restart: procedure
      .input(z.strictObject({ terminalId: id, cols: columns, rows, resume: agentName.optional() }))
      .output(terminalSummary),
  },
  // Agents whose sessions resume once Novadeck's plugin is installed into them.
  agents: {
    list: procedure.input(z.void()).output(z.array(agentIntegration)),
    // What the agent in a terminal does, in more detail than its summary: a snapshot, then
    // another on each change. It follows the terminal from agent to agent, and ends when
    // the terminal is closed. An unknown terminal is TERMINAL_NOT_FOUND.
    detail: procedure.input(z.strictObject({ terminalId: id })).output(eventIterator(agentDetail)),
    // An actor's conversation, as its harness recorded it: every item so far, then each
    // later one, while the terminal's agent runs the session the actor belongs to. An
    // actor it does not have, or one whose harness keeps no transcript Novadeck reads, is
    // NOT_FOUND; the stream ends when the terminal's agent moves to another session.
    transcript: procedure
      .input(z.strictObject({ terminalId: id, actor: agentRef }))
      .output(eventIterator(transcriptChange)),
    // Gives the terminal's agent a prompt as the person would: the text pasted into its own
    // input box as one bracketed paste, then Enter once the paste shows there, the person's
    // keys held meanwhile. A terminal without an agent bound, or one that takes no
    // bracketed paste, is a CONFLICT, as is one whose input box holds a draft already (the
    // person's, or a failed paste's), which a prompt would merge into; a paste that never
    // showed, or showed other than exactly the text, is PROMPT_FAILED, and what landed of it
    // stays in the box as a draft; text a TUI would read as a command or a file pick (a
    // leading `/` or `!`, a trailing `@name` or `$name`, a control character), or that is
    // nothing but white space, is PROMPT_REFUSED, writing nothing. `automatic` marks a fixed
    // line an Inbox button sends ("continue"), not words the person wrote: the turn it
    // starts is theirs to the doorbell and delivery, but takes no open ask out of the Inbox.
    prompt: procedure
      .input(
        z.strictObject({
          terminalId: id,
          text: z.string().min(1).max(16_384),
          automatic: z.literal(true).optional(),
        }),
      )
      .output(z.void()),
    // Answers a request waiting on the person through its dialog in the agent's TUI, as the
    // person would with its keys: the harness's adapter reads the dialog, checks it is the
    // request's, presses what the answer takes, and resolves once the dialog went as
    // expected. A request it doesn't have is NOT_FOUND; one whose dialog isn't on screen,
    // isn't recognised, or doesn't take the answer is a CONFLICT, and one that no longer reads
    // as the dialog the answer names (its `id` changed) is DIALOG_CHANGED, both pressing
    // nothing and leaving the dialog as it is (a CONFLICT from a dialog that showed and no
    // longer reads turns it `raw`, though). Keys pressed without the dialog going as
    // expected are ANSWER_FAILED (an answer that took whose following words, sent as the
    // agent's next prompt, did not go is WORDS_NOT_SENT: the dialog was answered), after which
    // the request's dialog turns `raw`, and nothing more is pressed for it.
    answer: procedure
      .input(z.strictObject({ terminalId: id, request: agentRef, answer: requestAnswer }))
      .output(z.void()),
    // Presses Escape in the terminal's agent, which stops its turn in every harness, and
    // takes back out of the agent's box what stopping put there (see `interruptResult`). A
    // terminal without an agent bound is a CONFLICT; a box that still holds the queued
    // messages, which could not be read or cleared with certainty, is BOX_NOT_CLEARED: the
    // turn is stopped, and the person is to clear the box in the terminal.
    interrupt: procedure.input(z.strictObject({ terminalId: id })).output(interruptResult),
    // Installs or removes the plugin through the agent's own commands.
    set: procedure
      .input(z.strictObject({ agent: agentName, connected: z.boolean() }))
      .output(agentIntegration),
  },
  // What agents show and the person attaches beside terminals: items held by a terminal's
  // bar or an undocked window, kept across restarts as pointers to files, pages and plans.
  companions: {
    // A session's items and windows. An unknown session is NOT_FOUND.
    list: procedure
      .input(z.strictObject({ sessionId: id }))
      .output(z.strictObject({ items: z.array(companionItem), windows: z.array(companionWindow) })),
    // Every item and window across sessions: each, `synced`, then later changes, as
    // `terminals.watch` reports terminals. What comes before `synced` is a set, applied
    // whole at `synced`. After it, each change is the latest state of its item or window,
    // in the order they first changed since the reader last caught up, so a reference
    // (an item's holder window, a window's item, an item's terminal) may name one not yet
    // reported, or one whose removal follows. They agree once the stream is idle.
    watch: procedure.input(z.void()).output(eventIterator(companionChange)),
    // What an item points at, read now, then again each time it changes, until it is
    // deleted. A file that may hold secrets is unavailable as `secret` unless `reveal` is the
    // path the item points at, the file the person chose to show: an item pointed at
    // another file since (a project window re-pointed) is `secret` again, and revealed again
    // if pointed back.
    // An unknown item is NOT_FOUND.
    content: procedure
      .input(z.strictObject({ itemId: id, reveal: z.string().max(4096).optional() }))
      .output(eventIterator(itemContent)),
    // Writes the person's edit to a plan kept in a file, atomically, unless the file
    // changed since `basedOn`, the stamp the edit was made on: then nothing is written and
    // the plan as it now stands comes back. A plan kept in an agent's transcript can't be
    // written, and nor can one past 256 KiB, a file that is gone, one in a folder the
    // runner may not write to, or an item that is no plan: PLAN_UNWRITABLE, saying why
    // (`gone`, `folder`, `transcript`, `too-large`, `not-a-plan`, `outside`). An unknown item is NOT_FOUND.
    save: procedure
      .input(
        z.strictObject({
          itemId: id,
          text: z.string().max(256 * 1024),
          basedOn: z.string().max(128),
        }),
      )
      .output(planSaveResult),
    // Attaches a file the person picked to a terminal's bar, by a path absolute or from
    // the terminal's directory. A terminal the runner keeps nothing of is
    // TERMINAL_NOT_FOUND; a path that is no file is INVALID_FILE, saying why.
    attach: procedure
      .input(
        z.strictObject({
          terminalId: id,
          path: z.string().min(1).max(4096),
          lines: z
            .strictObject({ from: z.int().min(1), to: z.int().min(1) })
            .refine(({ from, to }) => to >= from)
            .optional(),
          title: z.string().min(1).max(256).optional(),
        }),
      )
      .output(companionItem),
    // Opens a file in the session's project window, by a path absolute or from the
    // session's project folder: the item the window holds is pointed at it, with a later
    // version, or, with no project window yet, one is made under `windowId` holding a new
    // item. A session has one project window at most. An unknown session is NOT_FOUND, a
    // taken window id a CONFLICT, and a path that is no file INVALID_FILE, saying why.
    openInProject: procedure
      .input(z.strictObject({ sessionId: id, path: z.string().min(1).max(4096), windowId: id }))
      .output(z.strictObject({ item: companionItem, window: companionWindow })),
    // Tells the runner what went wrong on a page item while it showed its show `shown` (its
    // version then), as the pane saw it. The runner tells the agent that showed it, once per
    // show, at the next prompt the person gives it, for a page served from this machine
    // only. An unknown item, one that is no page, one not an agent's, a show other than its
    // latest, or a page elsewhere is let be.
    pageTrouble: procedure
      .input(
        z.strictObject({
          itemId: id,
          shown: z.int().min(1),
          troubles: z.array(pageTrouble).min(1).max(maxPageTroubles),
        }),
      )
      .output(z.void()),
    // Agents' looks at a page item, made through Novadeck's MCP server, for the client to
    // picture: the runner sends each to the client that subscribed last and waits a few
    // seconds for its `answerLook`.
    looks: procedure.input(z.void()).output(eventIterator(pageLook)),
    // Answers a look with a picture of the page, or why there's none. One the runner no
    // longer waits for, or sent to another client, is NOT_FOUND.
    answerLook: procedure.input(pageLookAnswer).output(z.void()),
    // Moves an item onto a terminal's bar, from a bar or a window, which goes with it; what
    // that bar held under the same pointer is replaced. An unknown item is NOT_FOUND, an
    // unknown terminal TERMINAL_NOT_FOUND, and one of another session, or the item of a
    // project window, which stays in it, a CONFLICT.
    move: procedure.input(z.strictObject({ itemId: id, terminalId: id })).output(companionItem),
    // Moves an item into a new window the client names; a taken id, or the item of a
    // project window, is a CONFLICT.
    undock: procedure.input(z.strictObject({ itemId: id, windowId: id })).output(companionWindow),
    // Deletes an item and the window holding it; closing a window is this call.
    close: procedure.input(z.strictObject({ itemId: id })).output(z.void()),
    // Gives a window the person's title. An unknown window is NOT_FOUND, a project window,
    // which its file names, CONFLICT.
    renameWindow: procedure
      .input(z.strictObject({ windowId: id, title: terminalTitle }))
      .output(z.void()),
    // Gives a window its item's name again; errors as `renameWindow` does.
    resetWindowTitle: procedure.input(z.strictObject({ windowId: id })).output(z.void()),
  },
  // The person's Inbox: what agents ask and tell them (see docs/agent-messaging.md).
  inbox: {
    list: procedure.input(z.void()).output(z.array(inboxEntry)),
    watch: procedure.input(z.void()).output(eventIterator(z.array(inboxEntry))),
    answer: procedure.input(z.strictObject({ id, answer: askAnswer })).output(z.void()),
    // Marks entries read: a tell stays as history, a finished turn is removed, an ask is
    // not touched. Unknown ids are skipped.
    read: procedure.input(z.strictObject({ ids: z.array(id).max(1000) })).output(z.void()),
    // The person dismisses an open ask without answering it: it stays listed, settled, and its
    // agent is told at its next hook. One that isn't an open ask is NOT_FOUND.
    dismiss: procedure.input(z.strictObject({ id })).output(z.void()),
    // Removes settled asks. Unknown ids, and any entry that isn't a settled ask, are skipped.
    clear: procedure.input(z.strictObject({ ids: z.array(id).max(1000) })).output(z.void()),
  },
  // Agents' feedback drafts for the people building Novadeck (see `feedbackDraft`): the app
  // shows each in its feedback card for the person to send or discard.
  feedback: {
    // The drafts waiting, oldest first, then again on each change.
    watch: procedure.input(z.void()).output(eventIterator(z.array(feedbackDraft))),
    // Drops a draft once the app sent it or the person discarded it; its agent isn't told.
    // One the runner doesn't hold is NOT_FOUND.
    settle: procedure
      .input(z.strictObject({ id, outcome: z.enum(["sent", "discarded"]) }))
      .output(z.void()),
    // Asks the agent in a terminal to write feedback about Novadeck from its session, with the
    // person's hint (empty for none): a message relayed from the person, delivered as their
    // Inbox answers are, waking an idle agent and waiting behind a turn in progress. The draft
    // arrives later with `asked`. An unknown terminal is TERMINAL_NOT_FOUND; one with no agent
    // session bound is NOT_FOUND; one whose earlier request is still waiting is CONFLICT.
    ask: procedure
      .input(z.strictObject({ terminalId: id, hint: z.string().max(maxFeedbackText) }))
      .output(z.void()),
  },
  messages: {
    // A terminal's threads and messages with their states. An unknown terminal is
    // TERMINAL_NOT_FOUND.
    list: procedure.input(z.strictObject({ terminalId: id })).output(terminalMessages),
    // What `list` says, then again on each change to the terminal's threads, messages or
    // delivery state, or to the pause, until the terminal is gone. An unknown terminal is
    // TERMINAL_NOT_FOUND.
    watch: procedure
      .input(z.strictObject({ terminalId: id }))
      .output(eventIterator(terminalMessages)),
    // Pauses messaging across the whole runner, every project and session, or resumes it.
    // The switch is stored, so it survives restarts; while paused, agents' messages are
    // held.
    pause: procedure.input(z.strictObject({ paused: z.boolean() })).output(z.void()),
    // Releases a held thread, and its pair's other held threads: their holds end, their held
    // messages are delivered, and their idle counts start afresh. One the runner does not keep
    // is NOT_FOUND.
    release: procedure.input(z.strictObject({ thread: threadId })).output(z.void()),
    // Stops a thread: its messages not yet delivered or leased are gone, their senders told
    // the person stopped it, and a send between the pair is refused for 10 minutes after the
    // later of the stop and the thread's last message. One the runner does not keep is
    // NOT_FOUND; stopping a stopped thread does nothing.
    stop: procedure.input(z.strictObject({ thread: threadId })).output(z.void()),
  },
  // Voice input, transcribed on this machine (see `voiceState`).
  voice: {
    // The addon's state, then again on each change.
    watch: procedure.input(z.void()).output(eventIterator(voiceState)),
    // Downloads the engine, unless it is there, and the model that suits this computer
    // (turbo, or small where turbo would not run well), checks that they transcribe, and
    // makes the model the one used. The person does not choose it. It returns once the
    // install starts; `watch` shows its progress, and its end or failure. One already
    // installing is a CONFLICT, and a build without an engine for this platform is
    // VOICE_UNAVAILABLE, whose data says why (see `voiceUnavailable`).
    install: procedure.input(z.void()).output(z.void()),
    // Stops an install, keeping what had finished before it. Nothing installing is fine.
    cancel: procedure.input(z.void()).output(z.void()),
    // Removes the engine and every model, and turns voice input off by choice: it is no
    // longer wanted, until the next install.
    uninstall: procedure.input(z.void()).output(z.void()),
    // Changes the settings given; the others stay. Turning voice input on before any
    // install says it is wanted, for the install to turn on.
    set: procedure.input(voiceChange).output(z.void()),
    // Adds audio to a clip being recorded, which the client names: 16 kHz mono 16-bit
    // little-endian PCM, base64, at the byte `offset` into the clip. Audio past
    // `maxVoiceSeconds` is UPLOAD_TOO_LARGE, and a part past the start of a clip the
    // runner does not have NOT_FOUND. Voice input that cannot be used is VOICE_UNAVAILABLE.
    // Clips nobody transcribes are forgotten after a few minutes.
    record: procedure
      .input(
        z.strictObject({
          clipId: id,
          offset: z.int().nonnegative(),
          data: z.base64().max(maxVoicePartLength),
        }),
      )
      .output(z.void()),
    // Transcribes a recorded clip and forgets it. `terminalId` names the terminal it is
    // dictated into, whose project, branch, folders, files and prompts the runner hints to
    // the engine to spell them right. An unknown clip is NOT_FOUND, voice input that
    // cannot be used VOICE_UNAVAILABLE, and an engine that fails VOICE_FAILED, saying why.
    transcribe: procedure
      .input(z.strictObject({ clipId: id, terminalId: id.optional() }))
      .output(voiceTranscript),
    // Forgets a clip without transcribing it. An unknown clip is fine.
    discard: procedure.input(z.strictObject({ clipId: id })).output(z.void()),
  },
  // Murmur, the local model that writes terminals' titles (see
  // `murmurState`).
  murmur: {
    // The addon's state, then again on each change.
    watch: procedure.input(z.void()).output(eventIterator(murmurState)),
    // Downloads the engine and the model, unless they are there, and checks that they
    // describe on this computer's graphics. It returns once the install starts; `watch` shows
    // its progress, and its end or failure. One already installing, or a computer the desktop
    // app saw only software rendering on, is a CONFLICT. An install's earlier `unsupported`
    // verdict is cleared by installing again, which checks anew.
    install: procedure.input(z.void()).output(z.void()),
    // Stops an install, keeping what had finished before it. Nothing installing is fine.
    cancel: procedure.input(z.void()).output(z.void()),
    // Removes the engine and the model, and turns murmur off by choice: it is no longer
    // wanted, until the next install.
    uninstall: procedure.input(z.void()).output(z.void()),
    // Changes the settings given; the others stay. Turning murmur on before any install
    // says it is wanted, for the install to turn on.
    set: procedure.input(murmurSettings.partial()).output(z.void()),
    // Counts a session of the app the one-time offer of murmur was shown in, which it stops
    // after three of.
    noteOffered: procedure.input(z.void()).output(z.void()),
  },
  settings: {
    get: procedure.input(z.void()).output(runnerSettingsState),
    // Changes the settings given; the others stay.
    set: procedure.input(runnerSettings.partial()).output(z.void()),
  },
}

/** The raw oRPC client. Applications use `connectRunner` from `@novadeck/runner-client`. */
export type WireClient = ContractRouterClient<typeof contract>
export type ErrorCode = keyof typeof errors
