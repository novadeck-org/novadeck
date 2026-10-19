import { Portal as ArkPortal } from "@ark-ui/react/portal"
import type { ReactNode } from "react"

// Renders its children at the end of the document, above everything the app lays out,
// such as something that follows the pointer across windows.
export const Portal = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <ArkPortal>{children}</ArkPortal>
)
