import { shellStateOf } from "@novadeck/core/agents/shells"

import type { ItemProps } from "../../registration"
import { useContent } from "../../store/use-item-store"
import { orderedShells } from "./shells"

// The shells in miniature: a dot and a command for each of the first few, failed first.
export const ShellsThumb = ({ item, itemStore, target }: ItemProps): React.JSX.Element | null => {
  const load = useContent(itemStore, target, item)
  if (load?.state !== "ready" || load.content.kind !== "shells") return null
  return (
    <ul className="peek-shells">
      {orderedShells(load.content.shells)
        .slice(0, 5)
        .map((shell) => (
          <li key={shell.id}>
            <span className="shells-dot" data-state={shellStateOf(shell)} aria-hidden />
            <code>{shell.command}</code>
          </li>
        ))}
    </ul>
  )
}
