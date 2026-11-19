import type { VideoContent } from "@novadeck/core/items"
import { Film } from "lucide-react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { formatName, bytesText } from "./format"
import { Playback } from "./Playback"
import { VideoPlayer } from "./VideoPlayer"

// A video of a pane, played with its own bar once its bytes are in, and its progress till then.
export const VideoViewer = (props: ArtifactBodyProps<"video">): React.JSX.Element => (
  <Playback {...props} element="video">
    {(url, stamp, onBroken) => (
      <VideoPlayer
        id={`${props.item.id}\n${props.item.path}`}
        src={url}
        name={props.item.name}
        shown={props.content.shown}
        at={props.content.at}
        current={stamp === props.stamp}
        onBroken={onBroken}
      />
    )}
  </Playback>
)

// The video's format and size, for its peek: its bytes are never read for it.
export const VideoThumb = ({ content }: { content: VideoContent }): React.JSX.Element => (
  <span className="peek-video">
    <Film size={18} strokeWidth={1.5} aria-hidden />
    <span>{formatName(content.mime)}</span>
    <span>{bytesText(content.size)}</span>
  </span>
)
