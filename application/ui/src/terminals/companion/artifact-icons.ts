import {
  BookText,
  FileCode2,
  FileStack,
  FileText,
  Globe,
  Image,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react"

import type { ArtifactKind } from "../../model/companion"
import type { BarMember, BarSlot } from "./bar"

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

// What a bar's member shows as, on the taskbar and on its terminal's tab: the messages,
// a plan (a subagent's apart), or its artifact's icon.
export const memberIcon = (member: BarMember): LucideIcon =>
  member.kind === "messages"
    ? MessagesSquare
    : member.item.kind === "plan"
      ? member.item.plan?.role === "subagent"
        ? FileStack
        : FileText
      : iconOf({ kind: member.item.kind, name: member.item.name })

// An icon on the bar: its one member's, or its stack's kind.
export const slotIcon = (slot: BarSlot): LucideIcon =>
  slot.stack === "plan"
    ? FileText
    : slot.stack
      ? kindIcons[slot.stack]
      : memberIcon(slot.members[0]!)
