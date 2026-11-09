import type { Refused } from "./conversation/prompt-refusal"
import type { AgentMessage, MessageWaits } from "./messages"
import type { Store } from "./store"
import type { TerminalKey } from "./types"

// The conversation of the agent a terminal runs, as the agent's own records tell it: its
// transcript (Claude Code's session JSONL, Codex's rollout, Antigravity's steps), read as
// the agent writes it, never through a second agent process. A terminal's chat view
// renders it in place of the terminal's screen; the agent's TUI keeps running beneath,
// and what the person sends from the chat is typed into it.

// What a tool call was, as its harness's decoder said: the chat's one line for it. The same
// shape as the protocol's `toolRun`, declared here since the core reads no more of the
// protocol than its data entries (a test holds the two to each other).
export type ToolKind = "run" | "read" | "write" | "search" | "web" | "agent" | "plan" | "other"
export type ToolRun = {
  readonly kind: ToolKind
  // What the tool is called to a person: "Ran", "Read", "Edited".
  readonly title: string
  // What it was called on: the command, the file, the pattern. Empty where there is none.
  readonly detail: string
  // The call starts a subagent whose result is its report, as the protocol's `toolRun` says.
  readonly subagent?: true | undefined
}

// What came of a tool call, in its harness's own words, as its decoder said; the same shape
// as the protocol's `toolOutcome`, as `ToolRun` is its `toolRun`. Every part is null where the
// harness doesn't say. `failed` is its word on the call, `exit` a command's exit code,
// `running` that the call goes on past its result (a command in the background, whose
// `failed` is then unknown), `size` a count it states, and `change` the lines it changed:
// `added` and `removed` count them all, and `lines` are the first, with the number the
// harness records for one, else null.
export type ToolChange = {
  readonly added: number
  readonly removed: number
  readonly lines: readonly {
    readonly sign: "+" | "-" | " "
    readonly text: string
    readonly line: number | null
  }[]
}
export type ToolOutcome = {
  readonly failed: boolean | null
  readonly exit: number | null
  readonly running: boolean
  readonly size: { readonly count: number; readonly unit: "line" | "match" | "file" } | null
  readonly change: ToolChange | null
  // Read from the words a result opens with, which holds only for a tool of the harness's
  // own: `groupItems` has dealt with that by the time a view reads an outcome.
  readonly opening: boolean
}

// One record of the conversation, in the order its harness wrote it: the person's or the
// agent's text, another agent's message to it (`author` names that agent, in its
// harness's words), a tool call with its input as text (often JSON), or a tool's result,
// which `call` pairs with its call; a result may come before its call. Text past what the
// backend carries is cut short and marked `truncated`. Private reasoning is never there.
export type ChatItem = {
  // Stable for the item while its session lasts, so a list can key by it.
  readonly id: string
  // Epoch milliseconds, where the harness recorded when.
  readonly at: number | null
  readonly role: "user" | "assistant" | "agent" | "tool" | "note"
  readonly kind: "text" | "tool-call" | "tool-result"
  readonly text: string
  readonly truncated: boolean
  // The tool's name, in the harness's words, on a call.
  readonly tool: string | null
  // What pairs a result with its call: the same on both, null where the harness says none.
  readonly call: string | null
  readonly author: string | null
  // On a call, what it was; null on every other item.
  readonly run: ToolRun | null
  // On a call or its result, what came of it, where its harness says. `groupItems` makes
  // one of the two.
  readonly outcome: ToolOutcome | null
  // A call the harness made inside a script of the agent's, and its result, recorded after
  // the script's own call.
  readonly scripted: boolean
  // A user item that records the person stopping the agent.
  readonly interrupted: boolean
  // A user item that is the line Novadeck's doorbell typed rather than the person's words:
  // `replies` where it carries their Inbox replies. Null on every other item.
  readonly ring: { readonly nonce: string; readonly replies: boolean } | null
  // On a `note` item, what its harness recorded between turns: the mode it says it's in, each
  // time it says so, a plan approved, or a compaction, whose summary is the item's text; or a
  // gap, a part of the record the backend can't read, the line as written its text, if any.
  readonly note?:
    | { readonly type: "mode"; readonly mode: string }
    | { readonly type: "plan-approved" }
    | { readonly type: "compaction" }
    | { readonly type: "gap" }
    | undefined
}

// What a request's dialog in the agent's TUI offers, as the backend read it, so the chat
// can answer it (`Conversations.answer`):
// - `choices`: options to pick one of (a permission, a plan approval). An option with
//   `text` takes the person's words: typed into the dialog's own field (`field`), or sent
//   as the agent's next prompt once it's chosen (`prompt`).
// - `questions`: one or more questions, each with its options, whether several may be
//   picked, and whether the person may answer in their own words.
// - `form`: a form an MCP server asks the person to fill: its message and fields (text, a
//   number, yes or no, or one of a set of choices), accepted with values or declined.
// - `raw`: a dialog is up, but it can't be answered from the chat: the backend doesn't
//   recognise it (as after an agent update changed it), the agent offers no way to
//   (`unsupported`), or an answer didn't take (`failed`). `text` is what the terminal
//   shows of it, to read; the person answers in the terminal.
// A readable dialog has an `id`, which an answer names: the backend refuses an answer to
// a dialog that no longer reads the same, pressing nothing. `detail` is what the dialog
// shows of what it asks about (the command, the tool's arguments), to read before
// answering.
export type ChatDialogOption = {
  readonly id: string
  readonly label: string
  readonly text: "field" | "prompt" | null
}
export type ChatQuestion = {
  readonly id: string
  readonly header: string | null
  readonly question: string
  readonly options: readonly {
    readonly id: string
    readonly label: string
    readonly description: string | null
  }[]
  readonly multiSelect: boolean
  readonly text: boolean
}
export type ChatFormField = {
  readonly id: string
  readonly label: string
  readonly description: string | null
  readonly kind: "text" | "number" | "boolean" | "choice"
  readonly choices: readonly string[]
  readonly required: boolean
}
export type ChatDialog =
  | {
      readonly type: "choices"
      readonly id: string
      readonly title: string | null
      readonly detail: string | null
      readonly options: readonly ChatDialogOption[]
    }
  | {
      readonly type: "questions"
      readonly id: string
      // Whether the person may set the questions aside to talk it over first, and how
      // their words reach the agent then: typed into the dialog, or as its next prompt.
      readonly chat: "field" | "prompt" | null
      readonly questions: readonly ChatQuestion[]
    }
  | {
      readonly type: "form"
      readonly id: string
      readonly message: string
      readonly fields: readonly ChatFormField[]
    }
  | {
      readonly type: "raw"
      readonly text: string
      readonly reason: "unrecognized" | "unsupported" | "failed"
    }

// The person's answer to a dialog: an option by id, with their words where it takes them;
// an answer per question, by ids, with the options picked and/or their own words; or a
// form accepted with a value per field, by id, or declined.
export type ChatAnswer =
  | {
      readonly type: "choice"
      readonly dialog: string
      readonly option: string
      readonly text?: string
    }
  | {
      readonly type: "questions"
      readonly dialog: string
      readonly answers: readonly {
        readonly question: string
        readonly options: readonly string[]
        readonly text?: string
      }[]
    }
  | { readonly type: "chat"; readonly dialog: string; readonly text?: string }
  | {
      readonly type: "form"
      readonly dialog: string
      readonly action: "accept" | "decline"
      readonly values: Readonly<Record<string, string | number | boolean>>
    }

// A request of the agent's, or of a subagent it started, that waits on the person: a
// permission, a question or a plan to approve, what it asks about, and the answers it
// offers, where its harness tells them. `dialog` is how its dialog in the agent's TUI
// reads, once it's on screen; null before, or where the backend reads none.
export type ChatRequest = {
  readonly id: string
  readonly kind: "permission" | "question" | "plan"
  readonly tool: string
  readonly subject: string | null
  readonly choices: readonly string[]
  // Whether a subagent asks, rather than the root agent.
  readonly subagent: boolean
  readonly dialog: ChatDialog | null
  // Whether it was answered from the chat and the agent has yet to report it settled.
  readonly answered: boolean
  // Whether it asks without waiting, as Codex's async questions: the agent works on and
  // takes prompts, and the request may outlast its turn.
  readonly detached?: true
}

// Whether a request is a question of the agent's own in a dialog the chat reads, not yet
// answered, that holds the agent: the person's own Send and Stop set it aside (`setAside`)
// rather than being refused for it, as a permission or a plan still refuses them, to be
// answered first. One that asks without waiting (`detached`) holds nothing to set aside.
export const openQuestion = (request: ChatRequest): boolean =>
  request.kind === "question" &&
  !request.answered &&
  request.detached !== true &&
  request.dialog?.type === "questions"

// The most questions one Send or Stop sets aside, as the protocol takes them.
export const maxSetAside = 8

// The ids of the questions the person's own Send or Stop sets aside (`openQuestion`), as
// many as one takes, the first first: should more wait, the backend refuses for the rest.
export const questionsToSetAside = (requests: readonly ChatRequest[]): readonly string[] =>
  requests
    .filter(openQuestion)
    .slice(0, maxSetAside)
    .map((request) => request.id)

// Whether the agent waits on such a question (`openQuestion`).
export const questionWaits = (requests: readonly ChatRequest[]): boolean =>
  requests.some(openQuestion)

// A prompt given the agent through `Conversations.send`, and whether its own record has it
// yet, as the backend reads that record (where it tells, `SendResult.tracked`): `pending`
// until it does; `settled` once it does, as the person's words of the item at `item` (its
// index in `items`), which a chat may show it as until that item arrives; `unrecorded`
// when the agent's turns went by and the record never got it; `in-box` when it didn't, and
// the words are back in the agent's own box; `withdrawn` when a Stop handed them back, with
// the `item` the record wrote for them where it did, which is no message that went.
// `text` is the prompt as given, null once withdrawn, or settled before its words were seen. `sentAt` is when it went,
// on the backend's clock.
export type ChatPrompt = {
  readonly ref: string
  readonly text: string | null
  readonly sentAt: number
  readonly state: "pending" | "settled" | "unrecorded" | "in-box" | "withdrawn"
  readonly item: number | null
}

// What the agent's own input box holds on its screen, which a message sent now goes out with,
// so that nothing goes unseen: `text` as the box shows it, `mode` whether that is its shell
// mode's, `tail` where that may be only the end of it, and `known` where all of it is a prompt
// of the person's that came back there, which the next message takes out and hands back to the
// chat's box rather than sending along.
export type ChatBox = {
  readonly text: string
  readonly mode: "prompt" | "shell"
  readonly tail: boolean
  readonly known: boolean
}

// Cells side by side in one style, as the terminal draws them (`agents.slice`): `width` is
// how many columns they take; a colour is a palette index or `#rrggbb`, null the default.
export type ChatSliceRun = {
  readonly text: string
  readonly width: number
  readonly fg: number | string | null
  readonly bg: number | string | null
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
}

// The rows of the terminal's screen that stand for something of the harness's own at its
// input, live. `reason`: a menu at the box, a view of its own, a dialog no adapter read.
// `secret`: rows a harness knows as a secret prompt, of which nothing keeps a copy. A slice
// goes to its reader and nowhere else: never to a log, a trace or telemetry.
export type ChatSlice = {
  readonly reason: "menu" | "view" | "dialog"
  readonly columns: number
  readonly rows: readonly (readonly ChatSliceRun[])[]
  readonly cursor: { readonly row: number; readonly column: number } | null
  readonly secret: boolean
}

// A terminal's conversation now. `agent` and `session` name the agent's session bound to
// the terminal whose transcript is read, its harness's name for the agent (`claude`,
// `codex`, `agy`); both null while none is. `loaded` once the session's records so far
// have started arriving. `items` are its root agent's, oldest first; subagents keep their
// own. `requests` wait on the person, oldest first. `prompts` are the session's prompts
// given through `send`, oldest first, as far as the backend follows them. `box` is what the agent's input box holds, null while there
// is nothing to show. `slice` is the terminal's own rows while something of the harness's own
// shows at its input.
export type Conversation = {
  readonly agent: string | null
  readonly session: string | null
  readonly loaded: boolean
  readonly items: readonly ChatItem[]
  readonly requests: readonly ChatRequest[]
  readonly prompts: readonly ChatPrompt[]
  readonly slice: ChatSlice | null
  readonly box: ChatBox | null
  readonly doorbell: ChatDoorbell
}

// What the doorbell has for the terminal's agent, as the Messages pane has it: the messages on
// their way to it, oldest first, those it was delivered, why the doorbell can't wake it now
// (`waits`, null where it can, or it needn't) and since when, and whether a ring is under way.
export type ChatDoorbell = {
  readonly waiting: readonly AgentMessage[]
  readonly delivered: readonly AgentMessage[]
  readonly waits: MessageWaits | null
  readonly waitsSince: number | null
  readonly ringing: boolean
}

export const noDoorbell: ChatDoorbell = {
  waiting: [],
  delivered: [],
  waits: null,
  waitsSince: null,
  ringing: false,
}

export const noConversation: Conversation = {
  agent: null,
  session: null,
  loaded: false,
  items: [],
  requests: [],
  prompts: [],
  slice: null,
  box: null,
  doorbell: noDoorbell,
}

// What `Conversations.send` resolves with, where its backend follows prompts: whether a
// receipt for it (`Conversation.prompts`, by the `ref` it was sent with) follows. A backend
// that follows none resolves with nothing. `returned`, where the message took words out of the
// agent's box to go (see `ChatBox`), are those words, for the chat's box.
export type SendResult = { readonly tracked: boolean; readonly returned?: string | null }

// What came back out of the agent's box, for the chat's: the `words` (null where none came, and
// for a message of images alone) and the `images`, as the paths `Conversations.uploadImage`
// answered, of the prompt images that came with them.
//
// `at` says where each image stood in the words (UTF-16 offsets into `words`, or into nothing
// where they are null, one per image, never back); absent, they all led.
export type BoxReturn = {
  readonly words: string | null
  readonly images?: readonly string[]
  readonly at?: readonly number[]
}

// Where a backend's conversations come from, and how the chat talks back to the agent.
export type Conversations = {
  // The conversation of the agent in a terminal, following the terminal from session to
  // session: the same store for the same terminal while anyone subscribes. Reading starts
  // with its first subscriber and stops once its last leaves.
  readonly conversation: (key: TerminalKey) => Store<Conversation>
  // Gives the terminal's agent a prompt as the person would type it into its box, then
  // Enter. Rejects with an Error whose message tells the person why it didn't go.
  // `automatic` marks a fixed line an Inbox button sends, not words the person wrote: the
  // agent's turn on it takes no open ask out of the Inbox. `ref` names its receipt in
  // `Conversation.prompts` (16 letters, digits, `_` or `-`; see `promptRef`), where the
  // backend follows it. `along` is the chat's own send, whose person can see what the agent's
  // box holds (`Conversation.box`): that goes out with it where it can. Without it, the box must
  // be empty. `images` are paths `uploadImage` answered, which go with the prompt as its
  // images; `text` may be empty then. `setAside` is the person's own Send over the questions the
  // agent asks (`openQuestion`), by their ids, as the person saw them: those are set aside and
  // the words go, in one step, where a request waiting on the person otherwise refuses them.
  // Any other request still does.
  readonly send: (
    key: TerminalKey,
    text: string,
    options?: {
      readonly automatic?: true
      readonly along?: true
      readonly setAside?: readonly string[]
      readonly ref?: string
      readonly images?: readonly string[]
      // Where each image goes in `text` (UTF-16 offsets, one per image, never back); absent,
      // they lead the text.
      readonly at?: readonly number[]
    },
  ) => Promise<SendResult | void>
  // Saves an image the person pasted on the agent's machine, which may not be this one, and
  // resolves with its path there, for `send`'s `images`. Absent where the backend takes no
  // images: the chat refuses a paste of one. Rejects with an Error whose message says why.
  readonly uploadImage?: (
    key: TerminalKey,
    file: { readonly name: string; readonly data: Uint8Array },
  ) => Promise<string>
  // What `uploadImage` takes, which the backend's protocol says: the most bytes of an image (a
  // larger one is never read), the media types, and how many images one message carries.
  readonly imageMaxBytes?: number
  readonly imageTypes?: readonly string[]
  readonly maxImages?: number
  // Stops the agent's turn, as Escape in its TUI does. Resolves with the words the person
  // had queued behind the turn, with the images that were in the box with them, which the
  // agent gave back and the chat's box takes again. Rejects as `send` does. `setAside`, the
  // person's own Stop over the questions the agent asks, by their ids, sets those aside and
  // stops the agent.
  readonly interrupt: (
    key: TerminalKey,
    options?: { readonly setAside?: readonly string[] },
  ) => Promise<BoxReturn>
  // Writes keys to the agent's terminal as the person's, for what shows in `slice`: a key or
  // an edit a call, in order. Where the backend has none, the chat keeps to its own menus' rule
  // (`refused`). Rejects as `send` does.
  readonly keys?: (key: TerminalKey, keys: string) => Promise<void>
  // Takes what the agent's own box holds out of it for the chat's, where it can be read whole
  // and the backend has a box: the words, or null where nothing was taken, which `box` then
  // still shows.
  readonly takeBox?: (key: TerminalKey) => Promise<BoxReturn>
  // Puts the chat's draft in the agent's own box, with no Enter, as the person goes to its
  // terminal: whether it went. Where not, the draft stays the chat's.
  readonly putBox?: (key: TerminalKey, text: string) => Promise<boolean>
  // Empties the agent's own box, as the person asked, of the text `box` showed them: whether
  // it reads empty now. Words gone are gone. Rejects as `send` does.
  readonly clearBox?: (key: TerminalKey, seen: string) => Promise<boolean>
  // Answers a request through its dialog in the agent's TUI, as the person would with its
  // keys, resolving once it took. Rejects as `send` does; a dialog that can't be answered
  // safely turns `raw`, for the person to answer in the terminal.
  readonly answer: (key: TerminalKey, request: string, answer: ChatAnswer) => Promise<void>
  // Whether `send`, or an answer's words that go on as a prompt, would be refused for the
  // text's shape, so the chat warns before it sends. Text that is nothing but white space
  // isn't refused here, though `send` refuses it: the chat sends no empty message, and an
  // option's words are optional, so there is nothing to warn about yet.
  readonly refused: Refused
}

// A fresh ref for a prompt's receipt, as the backend takes them.
export const promptRef = (): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => alphabet[byte % 64]).join("")
}

// What `Conversations.answer` rejects with when the answer took but the words that follow
// (sent as a prompt after an option or a chat) did not reach the agent: the request is
// answered, and what the person wrote is theirs to send again.
export class WordsLost extends Error {
  constructor() {
    super("Answered, but your words didn't reach the agent.")
    this.name = "WordsLost"
  }
}

// Why the agent couldn't take what was typed into its terminal for the person, as the
// backend says: a request waits on the person (`pending`), another agent's message is
// reaching it (`ringing`), its input box holds text that can't go along (`draft`), holds a
// command of the agent's own (`command`), is in a shell mode it can't be taken out of (`shell`)
// or isn't found on its screen (`no-box`), no agent is running there (`no-agent`), the text has
// no room in the box on this screen (`too-tall`), or the screen takes no pasted text yet
// (`no-paste`).
export type ConflictReason =
  | "pending"
  | "ringing"
  | "draft"
  | "no-agent"
  | "no-box"
  | "too-tall"
  | "shell"
  | "no-paste"
  | "command"
  | "question-words-only"

// What the person did that the agent couldn't take: sent a message, pressed Stop, or picked
// an option of a request.
export type ChatAction = "send" | "stop" | "answer"

// A failure the person settles in the agent's terminal, which the chat offers to show.
export class SettleInTerminal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettleInTerminal"
  }
}

// A message the agent couldn't take as the doorbell rang it: it can go once the ring is over,
// so the chat holds it in its queue rather than saying so.
export class RingUnderWay extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RingUnderWay"
  }
}

// The agent's box didn't read empty after the clear the person asked for.
export const boxNotCleared = (): SettleInTerminal =>
  new SettleInTerminal(
    "That didn't clear the agent's input box. Look at it above, or clear it in the terminal.",
  )

// A failure with the words the message took out of the agent's box before it failed, which the
// chat's box takes all the same: they are in the agent's no longer.
export const withReturned = <E extends Error>(failure: E, returned: string | undefined): E =>
  returned === undefined ? failure : Object.assign(failure, { returned })

// The words a failure came with (`withReturned`), if any.
export const returnedBy = (failure: unknown): string | undefined => {
  const { returned } = (failure ?? {}) as { readonly returned?: unknown }
  return typeof returned === "string" ? returned : undefined
}

// Stop took the turn's Escape, but the words queued behind it are still in the agent's box, for
// the terminal or the next message to see to.
export const notCleared = (): Error =>
  new Error(
    "Stopped. Your queued message is still in the agent's box: send it there, or try it with your next message here.",
  )

// What the person is told when the agent couldn't take what the chat typed for them, by
// why and by what they did: what clears by itself says to try that again, and what the
// person settles in the terminal says so and offers it. Without a reason the backend gave,
// the terminal is where to look.
export const conflictFailure = (reason: ConflictReason | undefined, action: ChatAction): Error => {
  const again = { send: "send again", stop: "stop it again", answer: "answer again" }[action]
  const retry = { send: "Send again", stop: "Stop it again", answer: "Try the answer again" }[
    action
  ]
  switch (reason) {
    case "pending":
      // A request's dialog takes a message's or a Stop's keys as its answer.
      return new Error(
        action === "stop"
          ? "The agent is waiting for your answer. Answer it first, then stop it."
          : "The agent is waiting for your answer. Answer it here, then send again.",
      )
    case "question-words-only":
      // A question set aside by words that answer it in its own field, which takes no images.
      return new Error(
        "The agent's question takes only words in its answer. Remove the images, or answer it first.",
      )
    case "ringing":
      return action === "send"
        ? new RingUnderWay(
            `Another agent's message is reaching it right now. ${retry} in a moment.`,
          )
        : new Error(`Another agent's message is reaching it right now. ${retry} in a moment.`)
    case "no-paste":
      return new Error(
        `The agent isn't ready for ${action === "send" ? "a message" : "that"} yet. ${retry} in a moment.`,
      )
    case "draft":
      return new Error(`The agent's input box already holds text. Clear it above, then ${again}.`)
    case "shell":
      return new Error(`The agent's input box is in shell mode. Clear it above, then ${again}.`)
    case "command":
      return new Error(
        `The agent's input box holds a command it hasn't run. Clear it above, then ${again}.`,
      )
    case "too-tall":
      return new SettleInTerminal(
        "This is too long for the agent's input box on this screen. Make the terminal larger or the message shorter.",
      )
    case "no-agent":
      return new SettleInTerminal("No agent is running in this terminal.")
    case "no-box":
      return new SettleInTerminal(
        "Novadeck can't find the agent's input box on its screen. Check the terminal.",
      )
    default:
      return new SettleInTerminal("The agent can't take that right now. Check its terminal.")
  }
}
