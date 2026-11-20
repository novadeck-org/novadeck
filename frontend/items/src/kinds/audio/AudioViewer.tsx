import { bytesText } from "@novadeck/core/command-text"
import type { AudioContent } from "@novadeck/core/items"
import { AudioLines } from "lucide-react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { formatName } from "../video/format"
import { Playback } from "../video/Playback"
import { AudioPlayer } from "./AudioPlayer"

// A recording of a pane, played as the whole pane once its bytes are in, and its progress till
// then. Its waveform is of the file it plays, which is the one before while a newer one is read.
export const AudioViewer = (props: ArtifactBodyProps<"audio">): React.JSX.Element => (
  <Playback {...props} element="audio">
    {(url, stamp, onBroken) => (
      <AudioPlayer
        id={`${props.item.id}\n${props.item.path}`}
        src={url}
        stamp={stamp}
        name={props.item.name}
        mime={props.content.mime}
        size={props.content.size}
        shown={props.content.shown}
        at={props.content.at}
        current={stamp === props.stamp}
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
