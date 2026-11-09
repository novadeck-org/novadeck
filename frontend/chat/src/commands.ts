import {
  boxNotCleared,
  returnedBy,
  RingUnderWay,
  promptRef,
  type ChatPrompt,
  type Conversation,
  type Conversations,
} from "@novadeck/core/conversation"
import type { BoxReturn } from "@novadeck/core/conversation"
import { shellCommand } from "@novadeck/core/conversation/prompt-refusal"
import type { TerminalKey } from "@novadeck/core/types"
import { uploadName } from "@novadeck/terminal/view"

import {
  attachmentsHold,
  chatAttachmentsOf,
  labelFor,
  releaseImages,
  setChatAttachments,
  withAttachment,
  type Attachment,
} from "./attachments"
import { withValue } from "./by-terminal"
import { chatDraftOf, joinDraft, mixes, setChatDraft, takenDraft } from "./drafts"
import {
  comeBack,
  gathered,
  heldImages,
  insertMarks,
  nextMark,
  splitDraft,
  withMarks,
  withMissingMarks,
  withoutMark,
} from "./placeholders"
import {
  chatReplyOf,
  replyAnswer,
  sameReply,
  setChatReply,
  type ChatReply,
  type ChatReplyTo,
} from "./replies"
import {
  chatReplySendOf,
  chatSendsOf,
  keepSentImages,
  keptImageAt,
  setChatSends,
  withSend,
  type ChatSend,
  type ChatSends,
} from "./sends"
import { withShell } from "./shells"
import { answeringInTerminal } from "./shown"
import type { Chat, ChatState } from "./state"

// What the chat does with its words, over the chat's own store.
export type ChatCommands = {
  // Keeps what the person has typed in the terminal's chat and not sent. An edit lets go
  // of words held from a reply whose question went: they are the person's message now.
  readonly setChatDraft: (terminalId: string, text: string, context?: string) => void
  // Adds pasted images to the terminal's draft and saves each on the agent's machine at once, so
  // they go with its next message. They show as uploading, then ready or failed. Answers why some
  // weren't added (too many for a message, or not images), or null where all were.
  // Each added image has its placeholder, `[Image #k]`, typed into the draft over `selection` (the
  // end of the draft where absent), and `caret` is where the person's caret goes, after them: null
  // where none was added.
  readonly attachChatImages: (
    key: TerminalKey,
    files: readonly File[],
    selection?: { readonly start: number; readonly end: number },
  ) => { readonly refusal: string | null; readonly caret: number | null }
  // Puts a line taken back to edit in the box ahead of what it holds: its words (with the
  // placeholders of its images) joined to the draft, the images numbered after the box's own.
  readonly restoreChat: (
    context: string,
    terminalId: string,
    words: string,
    images: readonly Attachment[],
  ) => void
  // Takes an image off the terminal's draft, and its placeholder out of the words; one still
  // uploading is dropped when it arrives.
  readonly removeChatImage: (context: string, terminalId: string, id: string) => void
  // Says whether the chat passes keys to the terminal's box, which it keeps off meanwhile.
  readonly setChatPassing: (terminalId: string, on: boolean) => void
  // Adds words to the draft of the terminal in a session, on a line of their own, reading
  // the draft as it is when it changes: whatever the person typed meanwhile stays. They go
  // after it, or before a shell command, so they never become more of its lines.
  readonly appendChatDraft: (context: string, terminalId: string, words: string) => void
  // Sends the draft's words, and its images where it is a plain message, to the terminal's
  // agent: as the answer to the question `to`
  // names, in its own field, at once, or else as a prompt, in its turn. They leave the draft
  // at once, so the box is free for the next words, whether or not the chat stays on screen.
  // A prompt goes once the one before it reached the agent's record, where the backend
  // tells (`Conversation.prompts`), else once it went. The promise resolves true once the
  // words went, and false once they came back to the box unsent, with others' that didn't go
  // or at a Stop; it rejects with why they didn't go, when they come back, before whatever
  // was typed meanwhile, with every prompt queued after them. A reply goes one at a time.
  // The images come back as the words do, and are not sent, but left in the draft, while one is
  // still uploading or has failed: it rejects, and the words stay too.
  readonly sendChat: (
    key: TerminalKey,
    text: string,
    to: ChatReply | null,
    // The images to send, where they aren't the box's: a line sent again takes its own.
    images?: readonly Attachment[],
  ) => Promise<boolean>
  // Moves what the agent's own box holds into the chat's, ahead of what's written there.
  readonly takeBox: (key: TerminalKey) => Promise<void>
  // Moves the chat's draft into the agent's own box, where it can go, as its terminal shows.
  readonly putDraft: (key: TerminalKey) => Promise<void>
  // Empties the agent's own box of `seen`, what the chat showed the person, gone for good, as
  // they asked. Rejects where it didn't.
  readonly clearBox: (key: TerminalKey, seen: string) => Promise<void>
  // Stops the agent's turn, as Escape in its TUI does. The prompts queued in the chat are
  // never sent after it: they come back to the box after the words the agent handed back,
  // and before what the box holds, their sends resolving false. Rejects as
  // `Conversations.interrupt` does, the queued prompts back in the box all the same.
  readonly stopChat: (key: TerminalKey) => Promise<void>
  // Sets the question the terminal's draft replies to in a session, or that it is held.
  readonly setChatReply: (context: string, terminalId: string, to: ChatReplyTo | null) => void
}

// How long a prompt sent with its receipt to follow may go without the conversation showing
// that receipt before the chat stops waiting on it, in milliseconds: the backend tells it as
// the prompt's Enter goes, so only a receipt it dropped first is never seen.
export const unseenMs = 15_000

// How long a prompt waits in the queue behind rings before the person is told, in milliseconds:
// a ring takes seconds, so one that outlasts this isn't ending by itself.
export const ringWaitMs = 60_000

// How long a prompt the agent turned away for a ring waits to try again, in milliseconds: a
// line a ring left in the box can stand there with no ring under way.
export const ringRetryMs = 1_000

// The session context a terminal's chat state is kept under.
const contextOf = (key: TerminalKey) => `${key.projectId}/${key.workspaceSessionId}`

// An object URL of a pasted image for its thumbnail; empty where the page can make none.
const previewOf = (file: Blob): string =>
  typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : ""

// Puts `back`, words with the placeholders of their images, in the terminal's box ahead of what
// it holds, `join` joining them, the images numbered after the box's own: no more images than a
// message takes, those the box has no room for are let go with their placeholders, and the
// terminal is told so.
const backInBox = (
  state: ChatState,
  context: string,
  terminalId: string,
  back: { readonly text: string; readonly images: readonly Attachment[] },
  max: number,
  join: (earlier: string, later: string) => string,
): Pick<ChatState, "attachments" | "imageNotes" | "drafts"> => {
  const { draft, images, over } = comeBack(
    back,
    chatDraftOf(state.drafts, context, terminalId),
    chatAttachmentsOf(state.attachments, context, terminalId),
    max,
    join,
  )
  releaseImages(over)
  return {
    drafts: setChatDraft(state.drafts, context, terminalId, draft),
    attachments: setChatAttachments(state.attachments, context, terminalId, images),
    imageNotes:
      over.length > 0
        ? withValue(
            state.imageNotes,
            context,
            terminalId,
            `The box holds ${max} images at most, so ${over.length} went.`,
          )
        : state.imageNotes,
  }
}

// The receipt of a prompt, as the conversation shows it now; null where it shows none.
const receiptOf = (conversation: Conversation, ref: string): ChatPrompt | null =>
  conversation.prompts.find((prompt) => prompt.ref === ref) ?? null

export const createChatCommands = ({
  chat,
  conversations,
  terminalOpen,
  context: currentContext,
  chatView,
}: {
  readonly chat: Chat
  // The agents' conversations, where the backend reads them.
  readonly conversations: Conversations | undefined
  // Whether the terminal is still in its session.
  readonly terminalOpen: (key: TerminalKey) => boolean
  // The current workspace context: `${projectId}/${workspaceSessionId}`.
  readonly context: () => string
  // Whether the chat view is on, so that terminals show as chats.
  readonly chatView: () => boolean
}): ChatCommands => {
  // How each prompt's promise settles, by ref, while it waits in the queue or goes.
  const settles = new Map<
    string,
    { readonly resolve: (went: boolean) => void; readonly reject: (failure: unknown) => void }
  >()
  // What follows each prompt sent until its receipt says whether the record has it, by ref.
  const watches = new Map<string, () => void>()

  const sendsOf = (key: TerminalKey) =>
    chatSendsOf(chat.store.getSnapshot().sends, contextOf(key), key.terminalId)
  // How many images a message carries, as the backend says; everything the box holds went in
  // through a backend that says.
  const most = (): number => conversations?.maxImages ?? 0
  // The attachments for images that came back out of the agent's box, by the paths they were
  // saved at: those this window sent, or one it didn't send, which has no thumbnail.
  const imagesFor = (key: TerminalKey, paths: readonly string[] | undefined): Attachment[] => {
    const own = sendsOf(key).flatMap((send) => send.images)
    return [...new Set(paths ?? [])].map(
      (path) =>
        own.find((image) => image.path === path) ??
        keptImageAt(path) ?? {
          id: promptRef(),
          n: 0,
          name: path.split(/[\\/]/).at(-1) || "image",
          preview: "",
          state: "ready",
          path,
          error: null,
        },
    )
  }
  const update = (key: TerminalKey, change: (sends: ChatSends) => ChatSends) =>
    void chat.update((state) => {
      const sends = change(state.sends)
      return sends === state.sends ? state : { ...state, sends }
    })

  // Takes the sends `taken` picks out of the terminal's queue and puts their drafts back in
  // the box, in order, ahead of whatever it holds now. Their promises resolve false, as
  // unsent, but for the one `failed` names, which rejects with why. Nothing goes back for a
  // terminal that closed meanwhile, whose draft went with it.
  const handBack = (
    key: TerminalKey,
    taken: (send: ChatSend) => boolean,
    failed?: readonly [string, unknown],
  ): void => {
    const context = contextOf(key)
    const { terminalId } = key
    const open = terminalOpen(key)
    const back = sendsOf(key).filter(taken)
    chat.update((state: ChatState) => {
      const left = chatSendsOf(state.sends, context, terminalId).filter((send) => !taken(send))
      const words = gathered(
        back.map((send) => ({ text: send.draft, images: send.images })),
        0,
        joinDraft,
      )
      return {
        ...state,
        ...(open && backInBox(state, context, terminalId, words, most(), joinDraft)),
        sends: setChatSends(state.sends, context, terminalId, left),
      }
    })
    // Nothing went back for a terminal that closed: its images go with it.
    if (!open) releaseImages(back.flatMap((send) => send.images))
    for (const send of back) {
      const settle = settles.get(send.ref)
      settles.delete(send.ref)
      if (failed && failed[0] === send.ref) settle?.reject(failed[1])
      else settle?.resolve(false)
    }
  }

  // Each terminal's latest take of what the agent's box holds.
  const takes = new Map<string, Promise<void>>()

  // Words a prompt took out of the agent's box are the person's again, ahead of what the box
  // holds now. Nothing goes back for a terminal that closed meanwhile.
  const wordsBack = (key: TerminalKey, words: string): void => {
    if (!terminalOpen(key)) return
    const context = contextOf(key)
    const { terminalId } = key
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(
        state.drafts,
        context,
        terminalId,
        joinDraft(words, chatDraftOf(state.drafts, context, terminalId)),
      ),
    }))
  }

  // The prompt's turn is over: it leaves the queue, and the next one goes. Its words being
  // back in the agent's own box would make the next one a draft there: those queued come
  // back to the chat's box instead.
  const finished = (key: TerminalKey, ref: string, inBox: boolean, keep = false): void => {
    watches.get(ref)?.()
    watches.delete(ref)
    const own = sendsOf(key).find((send) => send.ref === ref)
    const was = own?.phase
    // A line the record never got can be sent again, or taken back to edit, with its images.
    if (own) {
      if (keep) keepSentImages(ref, own.images, own.draft)
      else {
        const held = chatAttachmentsOf(
          chat.store.getSnapshot().attachments,
          contextOf(key),
          key.terminalId,
        )
        releaseImages(
          own.images.filter((image) => !held.some((each) => each.preview === image.preview)),
        )
      }
    }
    update(key, (sends) => withSend(sends, contextOf(key), key.terminalId, ref, () => null))
    if (inBox) handBack(key, (send) => send.phase === "queued")
    // One that settled already let the next go.
    else if (was !== "settled") pump(key)
  }

  // Follows a prompt's receipt until it says whether the record has it: it is done once it
  // does, or once it is gone, as when the agent moved to another session.
  const watch = (key: TerminalKey, ref: string): void => {
    const store = conversations!.conversation(key)
    let seen = false
    const session = store.getSnapshot().session
    let settled = false
    const look = (): void => {
      const conversation = store.getSnapshot()
      const receipt = receiptOf(conversation, ref)
      if (receipt) seen = true
      const gone = !receipt && (seen || (session !== null && conversation.session !== session))
      // Settled: the next goes at once, and its words stay to show it until its item
      // arrives, as the receipt carries none.
      if (!gone && receipt?.state === "settled" && receipt.item !== null) {
        if (conversation.items.length > receipt.item) return finished(key, ref, false)
        if (settled) return
        settled = true
        update(key, (sends) =>
          withSend(sends, contextOf(key), key.terminalId, ref, (send) => ({
            ...send,
            phase: "settled",
          })),
        )
        return pump(key)
      }
      if (gone || (receipt && receipt.state !== "pending"))
        finished(
          key,
          ref,
          receipt?.state === "in-box",
          receipt?.state === "unrecorded" || receipt?.state === "in-box",
        )
    }
    const unsubscribe = store.subscribe(look)
    // A receipt the backend dropped before this window saw it, as one whose session never
    // bound, holds the queue no longer than this.
    const unseen = setTimeout(() => {
      if (!seen && watches.has(ref)) finished(key, ref, false)
    }, unseenMs)
    watches.set(ref, () => {
      clearTimeout(unseen)
      unsubscribe()
    })
    look()
  }

  // Follows a prompt of images that no receipt follows until the record holds a turn after it, or
  // it has waited as long as a receipt does: its line shows meanwhile.
  const watchItems = (key: TerminalKey, ref: string): void => {
    const store = conversations!.conversation(key)
    const { items, session } = store.getSnapshot()
    const look = (): void => {
      const now = store.getSnapshot()
      if (now.items.length > items.length || now.session !== session) finished(key, ref, false)
    }
    const unsubscribe = store.subscribe(look)
    const unseen = setTimeout(() => {
      if (watches.has(ref)) finished(key, ref, false)
    }, unseenMs)
    watches.set(ref, () => {
      clearTimeout(unseen)
      unsubscribe()
    })
  }

  // Sends the terminal's next queued prompt, once no prompt before it is still on its way:
  // being typed, or sent and not yet in the agent's record.
  // Since when each prompt has waited behind rings, by ref, and what ends each terminal's wait.
  const ringWaits = new Map<string, number>()
  const heldByRing = new Map<string, () => void>()

  // Holds the terminal's queue behind the ring under way, `rest` at the least, then goes on. A
  // prompt that has waited `ringWaitMs` goes on all the same, for the agent to say.
  const holdForRing = (key: TerminalKey, ref: string, rest: number): void => {
    const { terminalId } = key
    if (heldByRing.has(terminalId)) return
    const since = ringWaits.get(ref) ?? Date.now()
    ringWaits.set(ref, since)
    const conversation = conversations!.conversation(key)
    let rested = rest === 0
    const look = (): void => {
      if (rested && !conversation.getSnapshot().doorbell.ringing) release()
    }
    const stop = conversation.subscribe(look)
    const rests = setTimeout(() => {
      rested = true
      look()
    }, rest)
    const gives = setTimeout(() => release(), Math.max(rest, since + ringWaitMs - Date.now()))
    const release = (): void => {
      clearTimeout(rests)
      clearTimeout(gives)
      stop()
      heldByRing.delete(terminalId)
      pump(key)
    }
    heldByRing.set(terminalId, release)
  }

  const pump = (key: TerminalKey): void => {
    const sends = sendsOf(key)
    const prompts = sends.filter((send) => send.to === null)
    if (prompts.some((send) => send.phase === "typing" || send.phase === "sent")) return
    const next = prompts.find((send) => send.phase === "queued")
    if (!next) return
    const context = contextOf(key)
    const { terminalId } = key
    if (heldByRing.has(terminalId)) return
    const waited = Date.now() - (ringWaits.get(next.ref) ?? Date.now())
    if (waited < ringWaitMs && conversations!.conversation(key).getSnapshot().doorbell.ringing) {
      holdForRing(key, next.ref, 0)
      return
    }
    update(key, (all) =>
      withSend(all, context, terminalId, next.ref, (send) => ({ ...send, phase: "typing" })),
    )
    // What the agent's box holds goes along only while the chat shows it. Words queued behind
    // others may go once the person has gone to the terminal, and may be typing there.
    const answering = answeringInTerminal(chat.store.getSnapshot().answering, context, terminalId)
    const shown = chatView() && !answering
    conversations!
      .send(key, next.text, {
        ref: next.ref,
        ...(shown && { along: true }),
        ...(next.images.length > 0 && {
          images: next.images.map(({ path }) => path!),
          at: next.at,
        }),
      })
      .then(
        (result) => {
          ringWaits.delete(next.ref)
          const settle = settles.get(next.ref)
          settles.delete(next.ref)
          settle?.resolve(true)
          if (result?.returned) wordsBack(key, result.returned)
          if (!sendsOf(key).some((send) => send.ref === next.ref)) return
          if (!result?.tracked && next.images.length === 0) return finished(key, next.ref, false)
          update(key, (all) =>
            withSend(all, context, terminalId, next.ref, (send) => ({ ...send, phase: "sent" })),
          )
          if (result?.tracked) watch(key, next.ref)
          else watchItems(key, next.ref)
        },
        // It didn't go: back in the box with every prompt queued after it, which would only
        // have gone after it.
        (failure: unknown) => {
          const since = ringWaits.get(next.ref) ?? Date.now()
          if (failure instanceof RingUnderWay && Date.now() - since < ringWaitMs) {
            ringWaits.set(next.ref, since)
            update(key, (all) =>
              withSend(all, context, terminalId, next.ref, (send) => ({
                ...send,
                phase: "queued",
              })),
            )
            const words = returnedBy(failure)
            if (words) wordsBack(key, words)
            holdForRing(key, next.ref, ringRetryMs)
            return
          }
          ringWaits.delete(next.ref)
          handBack(key, (send) => send.ref === next.ref || send.phase === "queued", [
            next.ref,
            failure,
          ])
          const taken = returnedBy(failure)
          if (taken) wordsBack(key, taken)
        },
      )
  }

  const sendReply = async (key: TerminalKey, text: string, to: ChatReply): Promise<boolean> => {
    const context = contextOf(key)
    const { terminalId } = key
    if (chatReplySendOf(chat.store.getSnapshot().sends, context, terminalId) !== null)
      throw new Error("Your last answer is still on its way. Send again once it arrives.")
    // The draft as typed goes back on a failure, not the words as sent, trimmed.
    const draft = chatDraftOf(chat.store.getSnapshot().drafts, context, terminalId) || text
    const ref = promptRef()
    // A reply takes words only, so the images whose placeholders were in the draft go with it.
    releaseImages(chatAttachmentsOf(chat.store.getSnapshot().attachments, context, terminalId))
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, terminalId, ""),
      attachments: setChatAttachments(state.attachments, context, terminalId, []),
      sends: setChatSends(state.sends, context, terminalId, [
        ...chatSendsOf(state.sends, context, terminalId),
        { ref, draft, text, images: [], at: [], to, phase: "typing" },
      ]),
    }))
    try {
      await conversations!.answer(key, to.request, replyAnswer(to, text))
    } catch (failure) {
      handBack(key, (send) => send.ref === ref)
      throw failure
    }
    // The reply ends with its answer. Words typed while it went were written as a reply, so
    // they are held for the person's edit, as for a reply whose question went, never sent as
    // a message unread.
    chat.update((state) => {
      const replied = sameReply(chatReplyOf(state.replies, context, terminalId), to)
      const typed = chatDraftOf(state.drafts, context, terminalId).trim() !== ""
      return {
        ...state,
        sends: withSend(state.sends, context, terminalId, ref, () => null),
        ...(replied && {
          replies: setChatReply(state.replies, context, terminalId, typed ? "held" : null),
        }),
      }
    })
    return true
  }

  // The terminals whose box the chat passes keys to.
  const passing = new Set<string>()

  // Saves a pasted image on the agent's machine and marks its attachment ready, or failed with
  // why. An attachment taken off meanwhile is left alone.
  // One image goes up at a time, whichever terminal, so the bytes of eight big ones are not all
  // in memory at once.
  let uploads: Promise<void> = Promise.resolve()
  const upload = (key: TerminalKey, id: string, file: File): void => {
    uploads = uploads.then(() => save(key, id, file))
  }
  const save = async (key: TerminalKey, id: string, file: File): Promise<void> => {
    const context = contextOf(key)
    const { terminalId } = key
    // Taken off while it waited its turn.
    if (
      !chatAttachmentsOf(chat.store.getSnapshot().attachments, context, terminalId).some(
        (each) => each.id === id,
      )
    )
      return
    const settle = (change: (attachment: Attachment) => Attachment): void =>
      void chat.update((state) => {
        const attachments = withAttachment(state.attachments, context, terminalId, id, change)
        return attachments === state.attachments ? state : { ...state, attachments }
      })
    try {
      const max = conversations?.imageMaxBytes
      if (max !== undefined && file.size > max)
        throw new Error(`It is over ${Math.floor(max / (1024 * 1024))} MiB.`)
      const path = await conversations!.uploadImage!(key, {
        name: uploadName(file, new Date()),
        data: new Uint8Array(await file.arrayBuffer()),
      })
      settle((attachment) => ({ ...attachment, state: "ready", path }))
    } catch (failure) {
      console.error("Could not save a pasted image on the agent's machine:", failure)
      const error =
        failure instanceof Error && failure.message ? failure.message : "It didn't upload."
      settle((attachment) => ({ ...attachment, state: "failed", error }))
    }
  }

  return {
    attachChatImages: (key, files, selection) => {
      if (!conversations?.uploadImage)
        return { refusal: "This backend can't take images.", caret: null }
      const context = contextOf(key)
      const { terminalId } = key
      const images = files.filter((file) => conversations.imageTypes?.includes(file.type))
      const held = chatAttachmentsOf(chat.store.getSnapshot().attachments, context, terminalId)
      const room = Math.max(0, most() - held.length)
      const names = held.map(({ name }) => name)
      const label = (file: File): string => {
        const name = labelFor(uploadName(file, new Date()), names)
        names.push(name)
        return name
      }
      const first = nextMark(
        chatDraftOf(chat.store.getSnapshot().drafts, context, terminalId),
        held,
      )
      const added = images.slice(0, room).map((file, index) => ({
        file,
        attachment: {
          id: promptRef(),
          n: first + index,
          name: label(file),
          preview: previewOf(file),
          state: "uploading",
          path: null,
          error: null,
        } satisfies Attachment,
      }))
      let caret: number | null = null
      if (added.length > 0) {
        chat.update((state) => {
          const draft = chatDraftOf(state.drafts, context, terminalId)
          const put = insertMarks(
            draft,
            selection?.start ?? draft.length,
            selection?.end ?? draft.length,
            added.map(({ attachment }) => attachment.n),
          )
          caret = put.caret
          return {
            ...state,
            imageNotes: withValue(state.imageNotes, context, terminalId, undefined),
            drafts: setChatDraft(state.drafts, context, terminalId, put.text),
            attachments: setChatAttachments(state.attachments, context, terminalId, [
              ...chatAttachmentsOf(state.attachments, context, terminalId),
              ...added.map(({ attachment }) => attachment),
            ]),
          }
        })
        for (const { file, attachment } of added) upload(key, attachment.id, file)
      }
      const refusal =
        images.length > added.length
          ? `A message takes at most ${most()} images.`
          : images.length < files.length
            ? "Only PNG, JPEG, GIF or WebP images can be attached."
            : null
      return { refusal, caret }
    },
    removeChatImage: (context, terminalId, id) => {
      const gone = chatAttachmentsOf(chat.store.getSnapshot().attachments, context, terminalId)
      releaseImages(gone.filter((each) => each.id === id))
      chat.update((state) => {
        const image = chatAttachmentsOf(state.attachments, context, terminalId).find(
          (each) => each.id === id,
        )
        const attachments = withAttachment(state.attachments, context, terminalId, id, () => null)
        return attachments === state.attachments || !image
          ? state
          : {
              ...state,
              attachments,
              drafts: setChatDraft(
                state.drafts,
                context,
                terminalId,
                withoutMark(chatDraftOf(state.drafts, context, terminalId), image.n),
              ),
              imageNotes: withValue(state.imageNotes, context, terminalId, undefined),
            }
      })
    },
    restoreChat: (context, terminalId, words, images) =>
      void chat.update((state) => ({
        ...state,
        ...backInBox(
          state,
          context,
          terminalId,
          { text: withMissingMarks(words, images, joinDraft), images },
          most(),
          joinDraft,
        ),
      })),
    setChatPassing: (terminalId, on) => {
      if (on) passing.add(terminalId)
      else passing.delete(terminalId)
    },
    setChatDraft: (terminalId, text, given) => {
      const context = given ?? currentContext()
      chat.update((state) => {
        const drafts = setChatDraft(state.drafts, context, terminalId, text)
        if (drafts === state.drafts) return state
        const held = chatReplyOf(state.replies, context, terminalId) === "held"
        // An image whose placeholder the edit took out goes with it.
        const { kept, gone } = heldImages(
          text,
          chatAttachmentsOf(state.attachments, context, terminalId),
        )
        releaseImages(gone)
        return {
          ...state,
          drafts,
          ...(gone.length > 0 && {
            attachments: setChatAttachments(state.attachments, context, terminalId, kept),
            imageNotes: withValue(state.imageNotes, context, terminalId, undefined),
          }),
          ...(held && {
            replies: setChatReply(state.replies, context, terminalId, null),
          }),
        }
      })
    },
    appendChatDraft: (context, terminalId, words) =>
      void chat.update((state) => {
        const draft = chatDraftOf(state.drafts, context, terminalId)
        return {
          ...state,
          drafts: setChatDraft(state.drafts, context, terminalId, joinDraft(draft, words)),
        }
      }),
    takeBox: async (key) => {
      // A shell command and a message don't make one draft: the box stays, and shows.
      const shown = conversations?.conversation(key).getSnapshot()
      const box = shown?.box
      const held = box && `${box.mode === "shell" ? "!" : ""}${box.text}`
      const draft = chatDraftOf(chat.store.getSnapshot().drafts, contextOf(key), key.terminalId)
      if (held && !mixes(held, draft)) return
      // The box's text is the keys the chat passes, or they are on their way out of it.
      if (passing.has(key.terminalId) || shown?.slice?.reason === "menu") return
      if (held && draft !== "" && (held.startsWith(draft) || draft.startsWith(held))) return
      const taking = (
        conversations?.takeBox?.(key) ?? Promise.resolve<BoxReturn>({ words: null })
      ).then(({ words, images: paths, at }) => {
        const images = imagesFor(key, paths)
        if ((!words && images.length === 0) || !terminalOpen(key)) return
        const context = contextOf(key)
        const { terminalId } = key
        chat.update((state) => ({
          ...state,
          ...backInBox(
            state,
            context,
            terminalId,
            withMarks(words ?? "", images, at),
            most(),
            takenDraft,
          ),
        }))
      })
      takes.set(key.terminalId, taking)
      await taking
    },
    putDraft: async (key) => {
      // Words on their way from the agent's box are part of what goes back.
      await takes.get(key.terminalId)
      const context = contextOf(key)
      const { terminalId } = key
      const state = chat.store.getSnapshot()
      const draft = chatDraftOf(state.drafts, context, terminalId)
      // Words written as a reply are for its question, and those on their way wait for the
      // ones before them to go.
      const busy = chatReplyOf(state.replies, context, terminalId) !== null
      // Its placeholders mean nothing in the agent's box, which takes no images from here.
      const imaged = chatAttachmentsOf(state.attachments, context, terminalId).length > 0
      if (!draft.trim() || busy || imaged || sendsOf(key).length > 0) return
      if (!(await conversations?.putBox?.(key, draft))) return
      chat.update((now) =>
        chatDraftOf(now.drafts, context, terminalId) === draft
          ? { ...now, drafts: setChatDraft(now.drafts, context, terminalId, "") }
          : now,
      )
    },
    sendChat: async (key, text, to, given) => {
      if (!conversations) throw new Error("This backend can't reach the agent.")
      if (to) return await sendReply(key, text, to)
      const context = contextOf(key)
      const { terminalId } = key
      const own = given === undefined
      const held = own
        ? chatAttachmentsOf(chat.store.getSnapshot().attachments, context, terminalId)
        : []
      // Images go with a message, not with a shell command, which only text can be.
      const shell = shellCommand(text) !== undefined
      const carried = given ?? (shell ? [] : held)
      const hold = attachmentsHold(carried)
      if (hold) throw new Error(hold)
      // The draft as typed, its placeholders in it, goes back on a failure, not the words as
      // sent, trimmed. A line sent again has its own, in its words.
      const draft = own
        ? chatDraftOf(chat.store.getSnapshot().drafts, context, terminalId) || text
        : withMissingMarks(text, carried, joinDraft)
      // What goes to the agent: the words without the placeholders, and where each image stood.
      const split = carried.length > 0 ? splitDraft(draft, carried) : null
      const images = split?.images ?? []
      const sentText = split ? split.text : text
      const places = split?.at ?? []
      if (shell) releaseImages(held)
      const ref = promptRef()
      const sent = new Promise<boolean>((resolve, reject) => settles.set(ref, { resolve, reject }))
      chat.update((state) => ({
        ...state,
        drafts: setChatDraft(state.drafts, context, terminalId, ""),
        // The images go with the message; those a shell command leaves behind are let go.
        attachments:
          own && held.length > 0
            ? setChatAttachments(state.attachments, context, terminalId, [])
            : state.attachments,
        imageNotes: withValue(state.imageNotes, context, terminalId, undefined),
        sends: setChatSends(state.sends, context, terminalId, [
          ...chatSendsOf(state.sends, context, terminalId),
          { ref, draft, text: sentText, images, at: places, to: null, phase: "queued" },
        ]),
      }))
      const at = Date.now()
      pump(key)
      const went = await sent
      // A command has no receipt, so the history keeps it from here.
      if (went && shellCommand(text) !== undefined)
        chat.update((state) => ({
          ...state,
          shells: withShell(state.shells, context, terminalId, { text, at }),
        }))
      return went
    },
    clearBox: async (key, seen) => {
      if (conversations?.clearBox && !(await conversations.clearBox(key, seen)))
        throw boxNotCleared()
    },
    stopChat: async (key) => {
      if (!conversations) throw new Error("This backend can't reach the agent.")
      // Out of the queue at once, so none goes while the turn is being stopped.
      const queued = sendsOf(key).filter((send) => send.phase === "queued")
      const refs = new Set(queued.map((send) => send.ref))
      update(key, (sends) =>
        setChatSends(
          sends,
          contextOf(key),
          key.terminalId,
          chatSendsOf(sends, contextOf(key), key.terminalId).filter((send) => !refs.has(send.ref)),
        ),
      )
      let returned: string | null = null
      let handed: readonly string[] | undefined
      let places: readonly number[] | undefined
      try {
        const result = await conversations.interrupt(key)
        returned = result.words
        handed = result.images
        places = result.at
      } finally {
        // Back in the box after what the agent handed back, which it had before them.
        const context = contextOf(key)
        const { terminalId } = key
        const open = terminalOpen(key)
        // What the agent's box gave back first, with its images where they stood, then what
        // waited in the chat.
        const back = gathered(
          [
            withMarks(returned ?? "", imagesFor(key, handed), places),
            ...queued.map((send) => ({ text: send.draft, images: send.images })),
          ],
          0,
          joinDraft,
        )
        if (!open) releaseImages(back.images)
        if (open && (back.text || back.images.length > 0))
          chat.update((state) => ({
            ...state,
            ...backInBox(state, context, terminalId, back, most(), joinDraft),
          }))
        for (const send of queued) {
          settles.get(send.ref)?.resolve(false)
          settles.delete(send.ref)
        }
      }
    },
    setChatReply: (context, terminalId, to) =>
      void chat.update((state) => {
        const replies = setChatReply(state.replies, context, terminalId, to)
        return replies === state.replies ? state : { ...state, replies }
      }),
  }
}
