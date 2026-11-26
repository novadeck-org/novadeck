import type { LucideIcon } from "lucide-react"
import { forwardRef } from "react"

import { NovaMark } from "../NovaLogo"

// Nova's mark in the place of an agent's icon: Novadeck's own mark (`NovaMark`), sized like the
// others. The mark draws itself in the theme's tokens, so `strokeWidth` and the colour of the
// text around it don't change it.
export const NovaIcon: LucideIcon = forwardRef(({ size = 24, className }, _ref) => (
  <NovaMark
    size={typeof size === "number" ? size : Number.parseInt(size, 10)}
    className={className}
  />
))
NovaIcon.displayName = "Nova"
