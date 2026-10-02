import { BookText, FileCode2, Globe, Image, type LucideIcon } from "lucide-react"

import type { ArtifactKind } from "../../model/companion"

export const kindIcons: Record<ArtifactKind, LucideIcon> = {
  image: Image,
  file: FileCode2,
  page: Globe,
}

// A markdown file reads as a document, as a plan does, not as code.
export const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)

// An artifact's icon: its kind's, or a document's for a markdown file.
export const iconOf = (artifact: {
  readonly kind: ArtifactKind
  readonly name: string
}): LucideIcon =>
  artifact.kind === "file" && isMarkdown(artifact.name) ? BookText : kindIcons[artifact.kind]
