import type { AudioContent } from "@novadeck/core/items"
import { AudioLines } from "lucide-react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { bytesText, formatName } from "../video/format"
import { Playback } from "../video/Playback"
import { AudioPlayer } from "./AudioPlayer"

// A recording of a pane, played on its card once its bytes are in, and its progress till then.
export const AudioViewer = (props: ArtifactBodyProps<"audio">): React.JSX.Element => (
  <Playback {...props} element="audio">
    {(url, onBroken) => (
      <AudioPlayer
        id={props.item.id}
        src={url}
        stamp={props.stamp}
        name={props.item.name}
        mime={props.content.mime}
        size={props.content.size}
        shown={props.content.shown}
        at={props.content.at}
        onBroken={onBroken}
      />
    )}
  </Playback>
)

// The recording's format and size, for its peek: its bytes are never read for it.
export const AudioThumb = ({ content }: { content: AudioContent }): React.JSX.Element => (
  <span className="peek-video">
    <AudioLines size={18} strokeWidth={1.5} aria-hidden />
    <span>{formatName(content.mime)}</span>
    <span>{bytesText(content.size)}</span>
  </span>
)
