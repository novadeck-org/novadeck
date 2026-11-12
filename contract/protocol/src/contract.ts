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
  setAsideRefs,
  conflictReason,
  imagePlaces,
  interruptResult,
  placesFit,
  promptFailure,
  promptResult,
} from "./agents.js"
import {
  changeFileDiff,
  changeRange,
  companionChange,
  companionLimits,
  companionItem,
  companionWindow,
  itemContent,
  maxChangeLayers,
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
import { closedTerminal, historyChange } from "./history.js"
import { askAnswer, inboxEntry } from "./inbox.js"
import { terminalMessages, threadId } from "./messages.js"
import { clientState, folderListing, project, workspaceSession } from "./projects.js"
import { runnerSettings, runnerSettingsState } from "./settings.js"
import { sliceChange } from "./slices.js"
import {
  approval,
  approvalAnswer,
  maxPromptImages,
  maxUploadPartLength,
  startupCommand,
  terminalAttached,
  terminalChange,
  terminalEvent,
  terminalRequest,
  terminalRequestAnswer,
  busyShells,
  terminalSummary,
  terminalTitle,
  terminalMove,
  terminalMoved,
} from "./terminals.js"
import { maxTranscriptImages, transcriptChange, transcriptImageResult } from "./transcripts.js"
import { workChange, workClosing, workMade } from "./works.js"

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
  // Optional data holds the words it took out of the box first (`promptFailure`).
  PROMPT_FAILED: { status: 409, data: promptFailure.optional() },
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
    // In the order the person arranged them; a session created since comes first.
    list: procedure.input(z.strictObject({ projectId: id })).output(z.array(workspaceSession)),
    // The new session comes first in its project's order.
    create: procedure.input(z.strictObject({ id, projectId: id, name })).output(workspaceSession),
    rename: procedure.input(z.strictObject({ sessionId: id, name })).output(workspaceSession),
    // Keeps how the person arranged the project's sessions: `order` by id, first to last.
    // Ids it doesn't have in the project are ignored; sessions `order` leaves out follow,
    // in the order they had.
    arrange: procedure
      .input(z.strictObject({ projectId: id, order: z.array(id).max(1000) }))
      .output(z.void()),
    // Closes every terminal of the session, as `terminals.close` does but whichever
    // connection controls them, keeping each in History, then forgets the session and what
    // it kept. A session the runner doesn't have, as one removed already, is NOT_FOUND;
    // the project's last session is CONFLICT, as a project always has one.
    remove: procedure.input(z.strictObject({ sessionId: id })).output(z.void()),
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
            // With `restore` and `resume`: the person is looking at the terminal. A
            // sleeping agent's wake that can't resume it then starts a plain shell saying
            // why; unseen (as for a message or a turn the stop cut short), it fails with
            // SPAWN_FAILED and the terminal stays asleep as it was.
            seen: z.boolean().optional(),
            // The History row to restore as this new terminal (`history.list`): in the
            // row's own directory, with its agent resumed or its saved output above a
            // fresh shell; the terminal takes the row's title and, unless the session has
            // taken it, handle. The row goes once the restore is confirmed. A row the runner
            // doesn't have is NOT_FOUND; one that is `restoring` or `gone`, or whose agent
            // isn't connected, a CONFLICT. It goes with none of the above but `sessionId`,
            // `cols` and `rows`. A create repeated with the same new id answers with the
            // terminal the first made, never CONFLICT, so a CONFLICT is always a refusal.
            closed: id.optional(),
          })
          .refine(({ command, restore, resume }) => !command || (!restore && !resume), {
            message: "A terminal either starts a command or restores what it ran, not both.",
          })
          .refine(
            ({ closed, command, restore, resume, cwd, title, requestId }) =>
              closed === undefined ||
              (!command && !restore && !resume && !cwd && !title && !requestId),
            { message: "A closed terminal is restored as it was, with nothing else to say." },
          ),
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
    // The person moves a terminal to another session of its project, running or saved,
    // without restarting it. A lead takes its whole team along, at every depth; a teammate
    // moved on its own leaves its lead. Each keeps its handle unless the session it goes to
    // has given it already, or a terminal there holds it or is led under it, then draws that
    // session's next, and its leads' handles follow in its team's `ledBy`. Its Inbox rows and
    // the companion items its bar holds go with it, and `watch` tells each move as a `changed` with the new `sessionId`. A terminal
    // it keeps nothing of is TERMINAL_NOT_FOUND; a session it doesn't have NOT_FOUND; the
    // terminal's own session, one of another project, or one being removed, a CONFLICT, as
    // is a move while a terminal of the team is closing, being stopped to rest or woken, has
    // a brief that hasn't arrived, or waits on a request: one to open a terminal, or an
    // approval the person hasn't answered.
    move: procedure.input(terminalMove).output(terminalMoved),
    // Every terminal across sessions, running or saved: `changed` for each, `synced`, then
    // later changes (creation, title, size, foreground process, exit, restart, and its
    // shell's record let go, when it is saved again) and `removed` once it is closed.
    watch: procedure.input(z.void()).output(eventIterator(terminalChange)),
    // The terminals, in every session and project, whose shell holds work a restart would
    // end. With no agent, as `terminals.close` judges it for an agent's request: a program in
    // the foreground, a line entered whose prompt hasn't come back, or a job in the background
    // or suspended. With an agent, whose own process is its session and resumes, only work
    // beside or under it: a bound agent by the rule that keeps an idle agent from resting (a
    // process under it that it didn't come up with, a job of the shell's beside it, the agent
    // suspended), one not yet bound by the shell's jobs beside it. `unknown` are the terminals
    // the runner could not read (the system's process list failed or was too slow, or an
    // agent's start isn't recorded yet), which a client must not take for idle. Read from the
    // system when asked, on Linux and macOS a fixed number of listings for all terminals, and never sampled: a client asks while
    // someone looks at the answer (every few seconds, as a restart's card is open) and when
    // it is about to act on it, not otherwise. Calls that overlap share one read, except that `fresh` waits for a read
    // that starts after the call, so what began before it is never taken for now (a client
    // about to act on the answer asks so). CLOSING while the runner stops.
    busy: procedure
      .input(z.strictObject({ fresh: z.literal(true).optional() }).optional())
      .output(busyShells),
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
    // The picture of a prompt image a transcript item lists (`TranscriptItem.images`): `offset`
    // and `index` are the ones the item carries, `sessionId` the session it was read in. The runner finds it again in the terminal's
    // bound session's own record, never at a path the caller names, and answers it as a data URL
    // if it is a PNG, JPEG, GIF or WebP of at most 8 MiB, else with why it is none. An
    // Antigravity picture lives in a file it saved under the session's own uploads, and is
    // answered only from there. A terminal with no bound session or transcript, or a line that
    // holds no such image, is NOT_FOUND; an unknown terminal is TERMINAL_NOT_FOUND.
    transcriptImage: procedure
      .input(
        z.strictObject({
          terminalId: id,
          // The session the item was read in, as `agents.detail` names it; another bound now is
          // NOT_FOUND, so a picture is never read from a session the caller didn't mean.
          sessionId: z.string().min(1).max(256),
          offset: z.int().nonnegative(),
          index: z
            .int()
            .nonnegative()
            .max(maxTranscriptImages - 1),
        }),
      )
      .output(transcriptImageResult),
    // The rows of the terminal's screen that stand for something of its harness's own at its
    // input (a menu at its box, a view of its own, a dialog no adapter reads): a snapshot, then
    // another on each change, null while nothing shows. It follows the terminal from agent to
    // agent and ends when the terminal is closed; an unknown terminal is TERMINAL_NOT_FOUND.
    // Its own stream, apart from `detail`: it changes on every key, and costs a look at the
    // screen only while someone reads it.
    slice: procedure.input(z.strictObject({ terminalId: id })).output(eventIterator(sliceChange)),
    // Gives the terminal's agent a prompt as the person would: the text pasted into its own
    // input box as one bracketed paste, then Enter once the paste shows there, the person's
    // keys held meanwhile. A terminal without an agent bound, or one that takes no
    // bracketed paste, is a CONFLICT. With `along`, text in the box goes out with the prompt,
    // what Novadeck knows there comes out and goes back as `returned`, and a shell mode is
    // left, where the screen shows that's safe; where not, or without `along`, that's a
    // CONFLICT (see docs/backend-api.md, "A box that isn't empty"); a paste that never
    // showed, or showed other than exactly the text, is PROMPT_FAILED, and what landed of it
    // stays in the box as a draft; text a TUI would read as a command or a file pick (a
    // leading `/` or `!`, a trailing `@name` or `$name`, a control character), or that is
    // nothing but white space, is PROMPT_REFUSED, writing nothing. `automatic` marks a fixed
    // line an Inbox button sends ("continue"), not words the person wrote: the turn it
    // starts is theirs to the doorbell and delivery, but takes no open ask out of the Inbox.
    // `ref` names the prompt's receipt in `agents.detail` (`promptReceipt`), which a client
    // may pick so its own copy of the prompt has the same key from the start; one the
    // terminal had already is a CONFLICT, writing nothing; without one, the runner picks it.
    // `tracked` says whether a receipt follows: not for a shell command (Codex records one
    // only once it ran, Antigravity none), nor where no agent shows in the terminal. A prompt
    // of images alone has one like any other.
    // `images` are files the person pasted into the chat, saved by `terminals.upload` on this
    // runner: each path is pasted into the agent's box on its own, as a person pastes an
    // image file, at its place in the text (`at`; before the text without it), and the agent
    // shows it as an image (Claude Code and Codex
    // as `[Image #1]`, Antigravity as an attachment line). A path this runner did not save
    // (by `terminals.upload`), or whose file is gone, is PROMPT_REFUSED, writing nothing; an
    // image the agent never shows is PROMPT_FAILED with data `{ reason: "image-not-shown" }`,
    // and what landed is cleared.
    // With `setAside`, the questions it names that the agent waits on (Claude Code's
    // AskUserQuestion, Codex's request_user_input, Antigravity's ask_question) don't refuse
    // the prompt; a ref no longer waiting is no matter: in the same
    // turn of the terminal's input, with nothing between, it is set aside and the words go.
    // Where the harness's Escape ends the turn there (Claude Code, Codex), Escape dismisses
    // it and the words follow as a prompt, images and all; where it only skips the question
    // (Antigravity), the words go as the answer to the question on screen, through its
    // Write-in, the rest skipped: no prompt, so `tracked` is false, and images there are a
    // CONFLICT (`question-words-only`), pressing nothing. A request it doesn't name, any other
    // request (an approval), a dialog not read as a question,
    // or one that doesn't go is still a CONFLICT (`pending`), pressing nothing; Escape pressed
    // without the question going is ANSWER_FAILED, the dialog turning `raw`.
    prompt: procedure
      .input(
        z
          .strictObject({
            terminalId: id,
            // Empty only with `images`: a prompt of nothing but pictures.
            text: z.string().max(16_384),
            // The paths `terminals.upload` answered for this runner, each an image the agent
            // takes first (see below); at most `maxPromptImages`.
            images: z.array(directory).min(1).max(maxPromptImages).optional(),
            // Where each image goes in the text (see `imagePlaces`); without it they lead.
            at: imagePlaces.max(maxPromptImages).optional(),
            automatic: z.literal(true).optional(),
            // Whether what the box holds may go along, or come out (see below): only where the
            // person can see it, as the chat shows it. Without it the box must be empty.
            along: z.literal(true).optional(),
            ref: agentRef.optional(),
            // The refs of the questions the person saw waiting (`agents.detail`'s requests),
            // which it sets aside to give the words (see below): only the person's own Send
            // in a chat, never an automatic prompt.
            setAside: setAsideRefs.optional(),
          })
          .refine((prompt) => prompt.text.length > 0 || prompt.images !== undefined, {
            message: "A prompt holds text, images, or both.",
            path: ["text"],
          })
          .refine((prompt) => placesFit(prompt.text, prompt.images, prompt.at), {
            message: "`at` gives each image a place in the text, in order.",
            path: ["at"],
          }),
      )
      .output(promptResult),
    // Writes keys to the agent's terminal as the person's, for what shows in `agents.slice`: a
    // chat holds no control of the terminal (`terminals.write`). A terminal with no agent, or
    // one held by a request whose dialog the chat answers, is a CONFLICT. A client sends one key
    // or edit a call, in order, and Enter on its own: a harness reads Enter right behind text
    // as part of a paste.
    keys: procedure
      .input(z.strictObject({ terminalId: id, keys: z.string().min(1).max(1024) }))
      .output(z.void()),
    // Takes what the agent's input box holds out of it and gives it to the client, as a chat
    // over the terminal is where the person writes: only what reads whole and steady off the
    // screen. Null where nothing was taken, the box's text then still in `agents.detail`'s
    // `box` (see docs/backend-api.md, "One input").
    takeBox: procedure.input(z.strictObject({ terminalId: id })).output(
      z.strictObject({
        returned: z.string().nullable(),
        images: z.array(directory).optional(),
        // Where each of `images` stood in `returned` (see `imagePlaces`); absent where they led.
        at: imagePlaces.optional(),
      }),
    ),
    // Puts a client's draft in the agent's input box, with no Enter, as the person goes to the
    // terminal: `placed` false where the box isn't empty, or the text would open a picker there,
    // and the draft stays the client's.
    putBox: procedure
      .input(z.strictObject({ terminalId: id, text: z.string().min(1).max(16_384) }))
      .output(z.strictObject({ placed: z.boolean() })),
    // Empties the agent's input box as the person asked, of whatever it holds, which is gone
    // for good: `seen` is its `text` as `agents.detail`'s `box` showed it to them, and a box
    // that no longer holds that is left. `cleared` false leaves it as it was, or as the keys
    // left it, the box still in `box` (see docs/backend-api.md, "One input").
    clearBox: procedure
      .input(z.strictObject({ terminalId: id, seen: z.string().min(1).max(16_384) }))
      .output(z.strictObject({ cleared: z.boolean() })),
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
    // turn is stopped, and the person is to clear the box in the terminal. With `setAside`,
    // only the person's own Stop in a chat, the questions it names (as `agents.prompt`'s)
    // that the agent waits on are set aside first,
    // in the same turn of the input: Escape until it is gone (one ends the turn in Claude
    // Code and Codex; Antigravity's skips one question a press), then the turn is stopped as
    // above if it still runs. Otherwise, and for any other request or one it doesn't name, a
    // request waiting is a CONFLICT (`pending`), as for `agents.prompt`.
    interrupt: procedure
      .input(z.strictObject({ terminalId: id, setAside: setAsideRefs.optional() }))
      .output(interruptResult),
    // Installs or removes the plugin through the agent's own commands.
    set: procedure
      .input(z.strictObject({ agent: agentName, connected: z.boolean() }))
      .output(agentIntegration),
  },
  // Terminals closed in the last 7 days, per project, to restore (`terminals.create`
  // with `closed`).
  history: {
    // A project's closed terminals, newest first, each with whether it can be restored now.
    // A project with none, or that the runner doesn't have, lists none.
    list: procedure.input(z.strictObject({ projectId: id })).output(z.array(closedTerminal)),
    // Every project's closed terminals: each `changed`, `synced`, then later changes
    // (a close, a restore's progress and outcome, a prune), as `terminals.watch` reports
    // terminals. An availability found by checking files is only as of when the list was read.
    watch: procedure.input(z.void()).output(eventIterator(historyChange)),
  },
  // Each tracked git worktree against its repository's main branch, for the Changes panel
  // (works.ts). A work is keyed by its worktree's root.
  works: {
    // Every project's works: each `changed`, `synced`, then later changes (new lines, a
    // look, a conflict found or gone, a worktree closed or no longer tracked).
    watch: procedure.input(z.void()).output(eventIterator(workChange)),
    // One event each time the runner starts tracking a worktree (any project's), from the
    // moment of subscribing: nothing replayed, no `synced`. Costs the runner no git reads.
    made: procedure.input(z.void()).output(eventIterator(workMade)),
    // The person has read the work as it is now: what's unread starts again from here. A
    // root with no work is NOT_FOUND.
    look: procedure.input(z.strictObject({ root: directory })).output(z.void()),
    // Shows the work as a changes item on a terminal's bar, as an agent's `show` with
    // `changes` would, and gives the item's id. The bar is its owner's, or, for a work with
    // no owner, `terminalId`'s. A root with no work, or no bar to show it on, is NOT_FOUND.
    show: procedure
      .input(z.strictObject({ root: directory, terminalId: id.optional() }))
      .output(z.strictObject({ itemId: id })),
    // Closes the worktree on the person's say: its uncommitted work (and commits only a
    // detached HEAD reaches) is kept on a ref, its folder removed, and its branch deleted only
    // when Novadeck made it and the main branch holds all of it (squash merges count). Without
    // `force` a worktree that holds uncommitted files or commits main lacks is not closed but
    // answered `closed: false` with what it holds, for the person to confirm. Refused as a
    // CONFLICT, saying why, while its owner's agent is working in it, and when git can't be
    // read or it has submodules. A root with no work is NOT_FOUND.
    close: procedure
      .input(z.strictObject({ root: directory, force: z.boolean().optional() }))
      .output(workClosing),
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
    // One file of a changes item as a selection of its layers changed it: the file's diff
    // and the text of each side, as one range of layers (see
    // `changeFileDiff`). A layer no longer there is left out, as is a file the selection
    // did not change (no runs). An unknown item, or one that is no change, is NOT_FOUND.
    changeFile: procedure
      .input(
        z.strictObject({
          itemId: id,
          path: z.string().min(1).max(companionLimits.path),
          layers: z.array(z.string().min(1).max(128)).min(1).max(maxChangeLayers),
        }),
      )
      .output(changeFileDiff),
    // The files a selection of a changes item's layers changed as one range (see
    // `changeRange`), which is what a selection of more than one layer shows, instead of
    // its layers' files added up. An unknown item, or one that is no change, is NOT_FOUND.
    changeRange: procedure
      .input(
        z.strictObject({
          itemId: id,
          layers: z.array(z.string().min(1).max(128)).min(1).max(maxChangeLayers),
        }),
      )
      .output(changeRange),
    // The person read a file of a changes item, by the name its content lists it under: the
    // item's content names it in `read` until the file changes again. Kept across restarts
    // with the Changes panel's memory. A file the change as a whole does not list is not
    // marked. An unknown item, or one that is no change, is NOT_FOUND.
    changeRead: procedure
      .input(z.strictObject({ itemId: id, path: z.string().min(1).max(companionLimits.path) }))
      .output(z.void()),
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
          text: z.string().max(companionLimits.plan),
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
