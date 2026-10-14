import { Check } from "lucide-react"

import { Markdown } from "../terminals/chat/Markdown"
import { agentName } from "./inbox-text"
import { Lead, Page, type SheetContentProps } from "./Page"
import { Failure, QuietLink, Sent } from "./sheet-parts"

// Update: a short report to skim, and acknowledge.
export const UpdateSheet = (props: SheetContentProps): React.JSX.Element | null => {
  const { item, sent, answering, failed, onNext, submit, reveal } = props
  if (item.kind !== "update") return null
  const { update } = item
  const files = update.type === "finished" ? update.files : []
  return (
    <Page>
      <Lead {...props} />
      <div className="inbox-prose">
        <Markdown text={update.type === "told" ? update.body : update.reply} />
      </div>
      {files.length > 0 && (
        <div className="inbox-files">
          <span className="inbox-evidence-label">Files it edited</span>
          {files.map((file) => (
            <span className="inbox-file" key={file}>
              {file}
            </span>
          ))}
        </div>
      )}
      {!sent && (
        <>
          <div className="inbox-actions">
            <button
              type="button"
              className="button primary text-control"
              disabled={answering}
              onClick={() => submit({ kind: "update", action: "read" }, "Marked read.")}
            >
              <Check size={12} aria-hidden />
              Mark read
            </button>
          </div>
          <div className="inbox-quiet-links">
            <QuietLink
              onClick={() => {
                submit({ kind: "update", action: "read" }, "Marked read.")
                reveal()
              }}
            >
              Give {agentName(item.source.agent)} a follow-up
            </QuietLink>
          </div>
        </>
      )}
      <Failure message={failed} />
      {sent && <Sent note={sent.note} onNext={onNext} />}
    </Page>
  )
}
