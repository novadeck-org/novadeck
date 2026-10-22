import { outline } from "@novadeck/viewers/text"

import { titleOf } from "./title"

// A document in miniature: its title over its sections. A plan's, and a markdown file's.
export const OutlineThumb = ({ path, text }: { path: string; text: string }): React.JSX.Element => (
  <span className="peek-plan">
    <b>{titleOf(path, text)}</b>
    {outline(text)
      .slice(0, 4)
      .map((heading) => (
        <span key={heading.at}>{heading.text}</span>
      ))}
  </span>
)
