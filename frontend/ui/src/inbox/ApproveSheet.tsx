import type { ChatAnswer, ChatDialogOption } from "@novadeck/core/conversation"
import type { HeldMessage } from "@novadeck/core/inbox"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Terminal } from "lucide-react"
import { useState } from "react"

import {
  agentName,
  actionOf,
  choicesOf,
  needsWords,
  setsStanding,
  type Choices,
} from "./inbox-text"
import { Lead, Page, type SheetContentProps } from "./Page"
import { CommandCard, Failure, QuietLink, ReplyBox, Sent, Text } from "./sheet-parts"

// Approve: what will happen, said once and large, and the decision. Allow and Deny are the
// dialog's own options; the harness's standing yes ("don't ask again") is a quiet link in
// its own words.

const choiceAnswer = (dialog: string, option: ChatDialogOption, text?: string): ChatAnswer => {
  const words = text?.trim()
  return { type: "choice", dialog, option: option.id, ...(words ? { text: words } : {}) }
}

const Permission = (
  props: SheetContentProps & {
    readonly choices: Choices
    readonly dialog: string
    readonly detail: string
    readonly plan: boolean
  },
): React.JSX.Element => {
  const { item, choices, dialog, detail, plan, sent, answering, failed, onNext, submit } = props
  const agent = agentName(item.source.agent)
  const [denying, setDenying] = useState(false)
  const [words, setWords] = useState("")
  const answer = (option: ChatDialogOption, note: string, text?: string): void =>
    submit({ kind: "request", answer: choiceAnswer(dialog, option, text) }, note)
  // The words go with the no that takes them; with none, the plain no does. Where the only
  // way back is the person's words (Claude's plan's "Tell Claude what to change"), it
  // needs them.
  const wordsNeeded = choices.plain === null && choices.note !== null && needsWords(choices.note)
  const deny = (text: string): void => {
    const given = text.trim() !== "" && choices.note !== null
    const option = given ? choices.note : (choices.plain ?? choices.note)
    if (!option || (wordsNeeded && !given)) return
    answer(
      option,
      given ? `Denied. ${agent} has your note.` : `Denied. ${agent} won't go ahead.`,
      given ? text : undefined,
    )
  }
  const canDeny = choices.note !== null || choices.plain !== null
  return (
    <Page>
      <Lead {...props} subject={plan} />
      {/* As the harness gave it: a first line set small as a folder could be the agent's own. */}
      <CommandCard folder={null} command={detail} />
      {!sent && !denying && (
        <div className="inbox-actions">
          {choices.allow ? (
            <button
              type="button"
              className="button primary text-control"
              disabled={answering}
              onClick={() =>
                answer(
                  choices.allow!,
                  plan ? `Approved. ${agent} is on it.` : `Allowed. ${agent} is working again.`,
                )
              }
            >
              {plan ? "Approve" : "Allow"}
            </button>
          ) : null}
          {choices.unsure.map((option) => (
            <button
              key={option.id}
              type="button"
              className="button text-control"
              disabled={answering}
              onClick={() => answer(option, `Answered. ${agent} is working again.`)}
            >
              <Text text={option.label} />
            </button>
          ))}
          {canDeny && (
            <button
              type="button"
              className="button text-control"
              disabled={answering}
              onClick={() => (choices.note ? setDenying(true) : deny(""))}
            >
              Deny
            </button>
          )}
        </div>
      )}
      {!sent && denying && (
        <>
          <ReplyBox
            value={words}
            onChange={setWords}
            onSend={() => deny(words)}
            placeholder={
              wordsNeeded
                ? `Tell ${agent} what to change`
                : `Tell ${agent} what to do instead (optional)`
            }
            label={`What ${agent} should do instead`}
            canSend={!answering && (!wordsNeeded || words.trim() !== "")}
            onCancel={() => setDenying(false)}
            sendLabel="Deny"
            autoFocus
            minRows={2}
          />
          <div className="inbox-quiet-links">
            <QuietLink onClick={() => setDenying(false)}>Cancel</QuietLink>
          </div>
        </>
      )}
      {!sent && !denying && choices.standing.length > 0 && (
        <div className="inbox-quiet-links">
          {choices.standing.map((option) => (
            <QuietLink
              key={option.id}
              disabled={answering}
              onClick={() =>
                answer(
                  option,
                  setsStanding(option)
                    ? `Allowed, and ${agent} won't ask again. It's working again.`
                    : `Answered. ${agent} is working again.`,
                )
              }
            >
              <Text text={option.label} />
            </QuietLink>
          ))}
        </div>
      )}
      <Failure message={failed} />
      {sent && <Sent note={sent.note} onNext={onNext} />}
    </Page>
  )
}

// A prompt that can't be answered from here: as the terminal shows it, and the way there.
export const Unanswerable = (
  props: SheetContentProps & { readonly text: string | null },
): React.JSX.Element => {
  const { item, text, sent, onNext, reveal } = props
  return (
    <Page>
      <Lead {...props} />
      {text && (
        <>
          <span className="inbox-caption">What the prompt shows in @{item.source.handle}</span>
          <pre
            className="inbox-screen"
            tabIndex={0}
            aria-label="The prompt as the terminal shows it"
          >
            {text}
          </pre>
        </>
      )}
      <p className="inbox-aside">
        Novadeck can&apos;t answer this prompt from here. Answer it in the terminal.
      </p>
      <div className="inbox-actions">
        <button type="button" className="button primary text-control" onClick={reveal}>
          <Terminal size={12} aria-hidden />
          Go to terminal
        </button>
      </div>
      {sent && <Sent note={sent.note} onNext={onNext} />}
    </Page>
  )
}

// A message Novadeck holds between two agents, which the person releases or stops.
const Held = (props: SheetContentProps & { readonly held: HeldMessage }): React.JSX.Element => {
  const { held, sent, answering, failed, onNext, submit } = props
  return (
    <Page>
      <Lead {...props} />
      <div className="inbox-route">
        <span>
          {held.from.title} <HandleChip handle={held.from.handle} />
        </span>
        <span aria-hidden="true">→</span>
        <span>
          {held.to.title} <HandleChip handle={held.to.handle} />
        </span>
      </div>
      <blockquote className="inbox-quote">{held.text}</blockquote>
      <p className="inbox-aside">
        This is message {held.hop} on the thread. Novadeck holds it so two agents can&apos;t keep
        going back and forth without you.
      </p>
      {!sent && (
        <div className="inbox-actions">
          <button
            type="button"
            className="button primary text-control"
            disabled={answering}
            onClick={() =>
              submit({ kind: "held", action: "release" }, `Released. ${held.to.title} has it.`)
            }
          >
            Release
          </button>
          <button
            type="button"
            className="button text-control"
            disabled={answering}
            onClick={() => submit({ kind: "held", action: "stop" }, "Stopped the thread.")}
          >
            Stop this thread
          </button>
        </div>
      )}
      <Failure message={failed} />
      {sent && <Sent note={sent.note} onNext={onNext} />}
    </Page>
  )
}

export const ApproveSheet = (props: SheetContentProps): React.JSX.Element | null => {
  const { item } = props
  if (item.kind === "held") return <Held {...props} held={item.held} />
  if (item.kind !== "request") return null
  const { request } = item
  const { dialog } = request
  const choices = dialog?.type === "choices" ? choicesOf(dialog.options) : null
  if (dialog?.type === "choices" && choices)
    return (
      <Permission
        {...props}
        choices={choices}
        dialog={dialog.id}
        detail={dialog.detail ?? request.subject ?? ""}
        plan={actionOf(request) === "plan"}
      />
    )
  return <Unanswerable {...props} text={dialog?.type === "raw" ? dialog.text : null} />
}
