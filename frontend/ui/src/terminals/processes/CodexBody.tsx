import type { ReactNode } from "react"

// Codex's content inside the shared window: where its own presentation can grow without
// touching other programs'.
export const CodexBody = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <>{children}</>
)
