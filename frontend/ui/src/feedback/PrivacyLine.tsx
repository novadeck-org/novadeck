import type { FeedbackAbout } from "@novadeck/core/feedback"
import { Lock } from "lucide-react"

import { privacyText } from "./feedback-state"

// What a note carries and what it doesn't, on one line that never wraps (the full text is
// its title, for a narrow card). The version and OS are set in mono. `about` is null while it
// is asked for.
export const PrivacyLine = ({
  about,
}: {
  readonly about: FeedbackAbout | null
}): React.JSX.Element => (
  <p className="feedback-privacy" title={privacyText(about)}>
    <Lock size={12} strokeWidth={1.75} aria-hidden="true" />
    <span className="feedback-privacy-text">
      {about === null ? (
        privacyText(null)
      ) : (
        <>
          Anonymous. We get this note, <span className="feedback-mono">{about.version}</span>,{" "}
          <span className="feedback-mono">{about.os}</span>.
        </>
      )}
    </span>
  </p>
)
