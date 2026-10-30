import { outline } from "@novadeck/viewers/text"

import { titleOf } from "./title"

// A Markdown document in miniature: its title over its sections. A plan's, and a file's.
export const OutlineThumb = ({ path, text }: { path: string; text: string }): React.JSX.Element => (
  <span className="peek-list">
    <b>{titleOf(path, text)}</b>
    {outline(text)
      .slice(0, 4)
      .map((heading) => (
        <span key={heading.at}>{heading.text}</span>
      ))}
  </span>
)
