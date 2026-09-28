import type { ReactNode } from "react"

// Claude's content inside the shared window: where its own presentation can grow without
// touching other programs'.
export const ClaudeBody = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <>{children}</>
)
