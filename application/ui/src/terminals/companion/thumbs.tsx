import type { ArtifactContent } from "../../model/companion"
import { ArtifactThumb } from "./ArtifactViewer"
import type { MailHandle } from "./mail"
import type { Shown } from "./pane"
import type { PlanDoc } from "./plan-doc"
import { headingsOf, titleOf } from "./plan-text"
import { useArtifactContent } from "./use-panes"

// What a peek shows of each thing behind a taskbar icon, in miniature.

// The plan: its title over its sections.
export const PlanThumb = ({ plan }: { plan: PlanDoc }): React.JSX.Element => (
  <span className="peek-plan">
    <b>{titleOf(plan.path, plan.text)}</b>
    {headingsOf(plan.text)
      .slice(0, 4)
      .map((heading) => (
        <span key={heading.at}>{heading.text}</span>
      ))}
  </span>
)

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
  load,
  artifact,
}: {
  load: (artifact: Shown) => Promise<ArtifactContent>
  artifact: Shown
}): React.JSX.Element | null => <ArtifactThumb load={useArtifactContent(load, artifact)} />

// Something the agent showed, once it loads. A held one is never loaded for a peek, which
// a passing pointer opens.
export const ArtifactPreview = ({
  load,
  artifact,
}: {
  load: (artifact: Shown) => Promise<ArtifactContent>
  artifact: Shown
}): React.JSX.Element =>
  artifact.held ? (
    <span className="peek-held">May hold secrets. Click to open.</span>
  ) : (
    <LoadedThumb load={load} artifact={artifact} />
  )
