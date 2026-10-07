import { CircleHelp, ClipboardList, ShieldQuestion, type LucideIcon } from "lucide-react"

import type { ChatRequest } from "../../model/conversation"

const kinds: Readonly<Record<ChatRequest["kind"], { title: string; Icon: LucideIcon }>> = {
  permission: { title: "Needs your permission", Icon: ShieldQuestion },
  question: { title: "Has a question", Icon: CircleHelp },
  plan: { title: "Plan to review", Icon: ClipboardList },
}

// What waits on the person. The agent's own box takes the answer, so each card sends them
// there rather than pretending to answer here.
export const Requests = ({
  requests,
  onAnswer,
}: {
  readonly requests: readonly ChatRequest[]
  readonly onAnswer: () => void
}): React.JSX.Element | null =>
  requests.length === 0 ? null : (
    <section className="chat-requests" aria-label="Waiting for you">
      {requests.map((request) => {
        const { title, Icon } = kinds[request.kind]
        return (
          <article
            key={request.id}
            className="chat-request"
            data-kind={request.kind}
            aria-label={`${title}: ${request.tool}`}
          >
            <header className="chat-request-head">
              <Icon size={14} strokeWidth={1.75} aria-hidden />
              <h3>{title}</h3>
              <span className="chat-request-tool">{request.tool}</span>
              {request.subagent && <span className="chat-request-tag">subagent</span>}
              <button type="button" className="button nodrag nopan" onClick={onAnswer}>
                Answer in terminal
              </button>
            </header>
            {request.subject && <p className="chat-request-subject">{request.subject}</p>}
            {request.choices.length > 0 && (
              <p className="chat-request-choices">
                <span>Options:</span> {request.choices.join(" · ")}
              </p>
            )}
          </article>
        )
      })}
    </section>
  )
