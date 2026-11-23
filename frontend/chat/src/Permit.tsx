import type { ChatPermit } from "@novadeck/core/conversation"
import { Menu } from "@novadeck/requests/Menu"
import { PermitFacts } from "@novadeck/requests/PermitFacts"
import { RequestFrame } from "@novadeck/requests/RequestCard"
import { useMounted } from "@novadeck/requests/use-mounted"
import { useState } from "react"

const reason = (failure: unknown): string =>
  failure instanceof Error && failure.message ? failure.message : "That didn't go through."

// A permit of the shipping gate that stands for the agent, as the settled state of the card the
// person answered: `Allowed`, what it covers, on which words, until when, and the one way to take
// it back (absent where the backend can't). A failed take back says so on the card.
export const Permit = ({
  permit,
  agent,
  onTakeBack,
}: {
  readonly permit: ChatPermit
  // The agent's name, for what it says of who is told.
  readonly agent: string
  readonly onTakeBack: ((permit: string) => Promise<void>) | undefined
}): React.JSX.Element => {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The clock the facts say a day against, as the card first showed.
  const [now] = useState(Date.now)
  const alive = useMounted()
  const press = (): void => {
    if (!onTakeBack || sending) return
    setSending(true)
    setError(null)
    onTakeBack(permit.id).then(
      () => {
        if (alive.current) setSending(false)
      },
      (failure: unknown) => {
        if (!alive.current) return
        setSending(false)
        setError(reason(failure))
      },
    )
  }
  return (
    <RequestFrame kind="permit" label={`Allowed: ${permit.title}`} title="Allowed" busy={sending}>
      <PermitFacts permit={permit} now={now} />
      {onTakeBack && (
        <div className="request-dialog">
          <Menu
            label="Answers"
            items={[{ key: "take-back", label: "Take back", effect: `${agent} is told.` }]}
            busy={sending}
            pressed={sending ? 0 : null}
            onPress={press}
          />
        </div>
      )}
      {error && (
        <p className="chat-error request-error" role="alert">
          {error}
        </p>
      )}
    </RequestFrame>
  )
}
