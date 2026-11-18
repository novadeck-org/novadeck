import { Progress } from "@novadeck/toolkit/Progress"
import { useEffect, useState } from "react"

import { Unavailable } from "../../ArtifactViewer"
import { usePaneNote } from "../../pane-row"
import { blobs } from "./blobs"
import { factsText, loadingText } from "./format"
import { useSource, type MediaProps } from "./source"

// The body of a video or a recording of a pane: its player once its bytes are in, its progress
// till then (centred while there is nothing to play, a chip over the player while a newer
// file's are read), or why there is nothing to play. `children` draws the player of the
// `url` it gets, and tells with `onBroken` that the browser can't decode what it was given.
export const Playback = ({
  element,
  children,
  ...props
}: MediaProps & {
  readonly element: "video" | "audio"
  readonly children: (url: string, onBroken: () => void) => React.ReactNode
}): React.JSX.Element => {
  const { item, content, itemStore } = props
  const source = useSource(props, element)
  usePaneNote([factsText(content.mime, content.size)])
  // The URL of the bytes the browser couldn't play, so a newer file's are tried afresh.
  const [broken, setBroken] = useState<string>()
  const { url, loaded, problem } = source
  // Held while it plays, so other files loading never revoke it under the player.
  useEffect(() => (url === undefined ? undefined : blobs.hold(url)), [url])
  if (problem === "here" || problem === "failed" || (url !== undefined && broken === url))
    return (
      <div className="artifact-status" role="alert">
        {problem === "failed"
          ? `${item.name} couldn't be loaded.`
          : `${item.name} can't be played here.`}
      </div>
    )
  if (problem)
    return (
      <Unavailable
        item={item}
        reason={problem}
        size={content.size}
        onReveal={() => itemStore.reveal(item.id, item.path)}
      />
    )
  return (
    <div className={`${element}-viewer`} aria-busy={url === undefined}>
      {url !== undefined && children(url, () => setBroken(url))}
      {loaded !== null && (
        <div
          className={`${element}-loading`}
          data-over={url !== undefined || undefined}
          role="status"
        >
          <p>{loadingText(loaded, content.size)}</p>
          <Progress
            label={`Loading the ${element === "video" ? "video" : "recording"}`}
            value={loaded}
            max={content.size}
          />
        </div>
      )}
    </div>
  )
}
