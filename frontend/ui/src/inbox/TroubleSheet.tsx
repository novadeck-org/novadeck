import type { Trouble } from "@novadeck/core/inbox"
import { unsaidWaits, waitsText } from "@novadeck/core/messages"
import { Switch } from "@novadeck/toolkit/Switch"
import { Check } from "lucide-react"
import { useId, useState } from "react"

import { agentName, clock, limitWindow } from "./inbox-text"
import { useInboxContext } from "./InboxProvider"
import { Lead, Page, type SheetContentProps } from "./Page"
import { Evidence, Failure, QuietLink, ReplyBox, Sent, Text } from "./sheet-parts"

// Trouble: what Novadeck noticed, said once, and the one fix it offers, with what it
// would send shown as it is.

type Stuck = Extract<Trouble, { type: "stuck" }>
type Limit = Extract<Trouble, { type: "limit" }>
type Failed = Extract<Trouble, { type: "failed" }>
type Waits = Extract<Trouble, { type: "waits" }>

const Stuck = (props: SheetContentProps & { readonly trouble: Stuck }): React.JSX.Element => {
  const { item, trouble, sent, answering, failed, onNext, submit } = props
  const agent = agentName(item.source.agent)
  const [writing, setWriting] = useState(false)
  const [words, setWords] = useState("")
  const nudge = (text: string, own?: true): void =>
    submit(
      { kind: "trouble", action: { type: "nudge", text, ...(own && { own }) } },
      `Interrupted and nudged. ${agent} is rethinking.`,
    )
  return (
    <Page>
      <Lead {...props} />
      <p className="inbox-lead">
        <Text text={trouble.summary} />
      </p>
      <Evidence handle={item.source.handle} lines={trouble.evidence} />
      {!sent && !writing && (
        <div className="inbox-fix">
          <div className="inbox-actions">
            <button
              type="button"
              className="button primary text-control"
              disabled={answering}
              onClick={() => nudge(trouble.nudge)}
            >
              Nudge it
            </button>
            <button
              type="button"
              className="button text-control"
              disabled={answering}
              onClick={() =>
                submit({ kind: "trouble", action: { type: "stop" } }, `Stopped ${agent}.`)
              }
            >
              Stop it
            </button>
          </div>
          <p className="inbox-sends">
            Nudge stops what it&apos;s doing and sends: <q>{trouble.nudge}</q>{" "}
            <QuietLink onClick={() => setWriting(true)}>Write your own</QuietLink>
          </p>
        </div>
      )}
      {!sent && writing && (
        <>
          <ReplyBox
            value={words}
            onChange={setWords}
            onSend={() => nudge(words.trim(), true)}
            placeholder="What should it try?"
            label={`What ${agent} should try`}
            canSend={!answering && words.trim() !== ""}
            onCancel={() => setWriting(false)}
            autoFocus
            minRows={2}
          />
          <div className="inbox-quiet-links">
            <QuietLink onClick={() => setWriting(false)}>Cancel</QuietLink>
          </div>
        </>
      )}
      <Failure message={failed} />
      {sent && <Sent note={sent.note} onNext={onNext} />}
    </Page>
  )
}

// A usage limit: one sentence, and whether Novadeck continues the agent when it resets.
const LimitReached = (
  props: SheetContentProps & { readonly trouble: Limit },
): React.JSX.Element => {
  const { item, trouble, sent, answering, failed, onNext, change, submit } = props
  const { now } = useInboxContext()
  const agent = agentName(item.source.agent)
  const title = useId()
  const hint = useId()
  const at = clock(trouble.resetsAt)
  return (
    <Page>
      <Lead {...props} />
      <p className="inbox-lead">
        {trouble.autoResume
          ? `${agent} used up its ${limitWindow(trouble.minutes)} window. Novadeck continues it when the limit resets at ${at}.`
          : `${agent} used up its ${limitWindow(trouble.minutes)} window, which resets at ${at}. It stays stopped until you continue it.`}
      </p>
      {trouble.autoResume !== null && (
        <div className="inbox-switch-row">
          <Switch
            checked={trouble.autoResume}
            labelledBy={title}
            describedBy={hint}
            onChange={(on) => change({ kind: "trouble", action: { type: "auto-resume", on } })}
          />
          <span className="inbox-switch-copy">
            <span id={title} className="inbox-switch-title text-body">
              Resume automatically at {at}
            </span>
            <span id={hint} className="inbox-switch-hint text-caption">
              {trouble.autoResume
                ? "Turn off to keep it paused until you continue it yourself."
                : "It stays paused until you continue it yourself."}
            </span>
          </span>
        </div>
      )}
      {!trouble.autoResume && !sent && trouble.resetsAt <= now && (
        <div className="inbox-actions">
          <button
            type="button"
            className="button primary text-control"
            disabled={answering}
            onClick={() =>
              submit(
                { kind: "trouble", action: { type: "continue" } },
                `Told ${agent} to continue.`,
              )
            }
          >
            Continue now
          </button>
        </div>
      )}
      <Failure message={failed} />
      {sent && <Sent note={sent.note} onNext={onNext} />}
    </Page>
  )
}

// A turn that ended in an error. Only the agent's current end, with the agent at rest, offers
// to fix it; an older one, or one with the agent working again, is read.
const Errored = (props: SheetContentProps & { readonly trouble: Failed }): React.JSX.Element => {
  const { item, trouble, sent, answering, failed, onNext, submit } = props
  const agent = agentName(item.source.agent)
  return (
    <Page>
      <Lead {...props} />
      {trouble.error ? (
        <pre className="inbox-error" tabIndex={0} aria-label="The error">
          {trouble.error}
        </pre>
      ) : (
        <p className="inbox-lead">{agent} ended its turn on an error and gave no reason.</p>
      )}
      {!sent && (
        <div className="inbox-actions">
          {item.stopped && (
            <button
              type="button"
              className="button primary text-control"
              disabled={answering}
              onClick={() =>
                submit(
                  {
                    kind: "trouble",
                    action: {
                      type: "nudge",
                      text: "Your last turn ended in an error. Look at what went wrong and fix it.",
                    },
                  },
                  `Asked ${agent} to fix it.`,
                )
              }
            >
              Ask it to fix
            </button>
          )}
          {trouble.stored && (
            <button
              type="button"
              className={item.stopped ? "button text-control" : "button primary text-control"}
              disabled={answering}
              onClick={() => submit({ kind: "trouble", action: { type: "read" } }, "Marked read.")}
            >
              <Check size={12} aria-hidden />
              Mark read
            </button>
          )}
        </div>
      )}
      <Failure message={failed} />
      {sent && <Sent note={sent.note} onNext={onNext} />}
    </Page>
  )
}

// Messages held long behind what keeps the doorbell from the idle agent, which only the
// person can clear, in its terminal.
const HeldUp = (props: SheetContentProps & { readonly trouble: Waits }): React.JSX.Element => {
  const { trouble, reveal } = props
  return (
    <Page>
      <Lead {...props} />
      <p className="inbox-lead">{trouble.waits ? waitsText[trouble.waits] : unsaidWaits.text}</p>
      <div className="inbox-actions">
        <button type="button" className="button primary text-control" onClick={reveal}>
          Show terminal
        </button>
      </div>
    </Page>
  )
}

export const TroubleSheet = (props: SheetContentProps): React.JSX.Element | null => {
  const { item } = props
  if (item.kind !== "trouble") return null
  const { trouble } = item
  if (trouble.type === "stuck") return <Stuck {...props} trouble={trouble} />
  if (trouble.type === "limit") return <LimitReached {...props} trouble={trouble} />
  if (trouble.type === "waits") return <HeldUp {...props} trouble={trouble} />
  return <Errored {...props} trouble={trouble} />
}
