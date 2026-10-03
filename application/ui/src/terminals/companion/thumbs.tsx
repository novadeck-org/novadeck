import type { CompanionItem } from "../../model/companion"
import type { WorkspaceTarget } from "../../model/types"
import { ArtifactThumb } from "./ArtifactViewer"
import type { MailHandle } from "./mail"
import { headingsOf, titleOf } from "./plan-text"
import type { Panes } from "./state"
import { useContent, usePlan } from "./use-panes"

// What a peek shows of each thing behind a taskbar icon, in miniature.

// The plan: its title over its sections, its name until it loads.
export const PlanThumb = ({
  panes,
  item,
}: {
  panes: Panes
  item: CompanionItem
}): React.JSX.Element => {
  const plan = usePlan(panes, item.id)
  const text = plan?.text ?? ""
  return (
    <span className="peek-plan">
      <b>{titleOf(item.name, text)}</b>
      {headingsOf(text)
        .slice(0, 4)
        .map((heading) => (
          <span key={heading.at}>{heading.text}</span>
        ))}
    </span>
  )
}

// The threads: the agents they're with, latest first.
export const MailThumb = ({
  mail,
  peerName,
}: {
  mail: MailHandle
  peerName: (handle: string) => string | undefined
}): React.JSX.Element => {
  const threads = mail.mail?.threads ?? []
  return (
    <span className="peek-plan peek-mail">
      <b>{threads.length ? "Threads" : "No messages yet"}</b>
      {threads.slice(0, 4).map((thread) => (
        <span key={thread.id}>
          {peerName(thread.peer) ?? thread.peer} · {thread.peer}
        </span>
      ))}
    </span>
  )
}

const LoadedThumb = ({
  panes,
  target,
  item,
}: {
  panes: Panes
  target: WorkspaceTarget
  item: CompanionItem
}): React.JSX.Element | null => <ArtifactThumb load={useContent(panes, target, item)} />

// Something the agent showed, once it loads. A held one is never loaded for a peek, which
// a passing pointer opens.
export const ArtifactPreview = ({
  panes,
  target,
  item,
}: {
  panes: Panes
  target: WorkspaceTarget
  item: CompanionItem
}): React.JSX.Element =>
  item.held ? (
    <span className="peek-held">May hold secrets. Click to open.</span>
  ) : (
    <LoadedThumb panes={panes} target={target} item={item} />
  )
