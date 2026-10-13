import { ExternalLink, FileCode } from "lucide-react"

import { atlas } from "../atlas-data.ts"
import type { Anchor } from "../atlas.ts"

export const blobUrl = (file: string, line?: number | null) =>
  `${atlas.repository}/blob/${atlas.commit}/${file}${line ? `#L${line}` : ""}`

export const AnchorLink = ({ anchor }: { anchor: Anchor }) => {
  const { file, line } = anchor
  if (line === null) {
    return (
      <span
        className="font-mono text-[12px] text-bad line-through"
        title="Anchor text no longer found"
      >
        {file}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <a
        href={blobUrl(file, line)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-[12px] no-underline hover:underline"
      >
        {file}:{line}
      </a>
      <a
        href={`vscode://file/${atlas.root}/${file}:${line}`}
        className="text-muted hover:text-fg"
        title="Open in VS Code"
      >
        <ExternalLink size={11} />
      </a>
    </span>
  )
}

// An anchor as a small icon: the path shows on hover, a click opens it on GitHub. For
// places where the picture carries the meaning and the file is a detail.
export const AnchorIcon = ({ anchor, size = 13 }: { anchor: Anchor; size?: number }) => {
  const { file, line } = anchor
  if (line === null) {
    return (
      <span className="inline-flex text-bad" title={`${file}: anchor text no longer found`}>
        <FileCode size={size} />
      </span>
    )
  }
  return (
    <a
      href={blobUrl(file, line)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex text-muted hover:text-accent"
      title={`${file}:${line}`}
      onClick={(event) => event.stopPropagation()}
    >
      <FileCode size={size} />
    </a>
  )
}
