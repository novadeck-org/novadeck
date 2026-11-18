import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react"

import { Control } from "../video/Control"
import { actionOf, jump, nextSpeed, type Action } from "../video/controls"
import { clock, factsText } from "../video/format"
import { useMedia } from "../video/useMedia"
import { usePeaks } from "./peaks"
import { Waveform } from "./Waveform"

// A recording played on a card: its name and facts, a play button beside its waveform (which
// is the scrubber), and a bar of time, loop, speed and mute, whose keys a player in focus
// reaches too. Nothing here is a picture: the element is never shown. What it does with the
// element is `useMedia`'s, as the video player's is.
export const AudioPlayer = ({
  id,
  src,
  stamp,
  name,
  mime,
  size,
  shown,
  at,
  onBroken,
}: {
  id: string
  src: string
  stamp: string
  name: string
  mime: string
  size: number
  shown: number
  at: number | undefined
  // The browser can't play it: its bytes aren't a recording it can decode.
  onBroken: () => void
}): React.JSX.Element => {
  const media = useMedia<HTMLAudioElement>({ id, src, shown, at })
  const { ref, paused, time, duration, loop, speed, muted, seek, events } = media
  const peaks = usePeaks({ id, stamp, url: src, size, duration })

  const act = (action: Action): void => {
    const element = ref.current!
    switch (action) {
      case "toggle":
        return media.toggle()
      case "back":
        return seek(element.currentTime - jump)
      case "forward":
        return seek(element.currentTime + jump)
      case "loop":
        return media.setLoop((on) => !on)
      case "mute":
        return media.setMuted((on) => !on)
      // A recording has no frames and no picture to fill the screen with.
      case "before":
      case "after":
      case "full":
    }
  }

  return (
    <div
      className="audio-player"
      tabIndex={0}
      data-own-keys=""
      role="group"
      aria-label={`Recording ${name}`}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return
        // A button takes its own space.
        if (event.key === " " && event.target instanceof Element && event.target.closest("button"))
          return
        const action = actionOf(event.key)
        if (!action) return
        event.preventDefault()
        act(action)
      }}
    >
      <div className="audio-card">
        <div className="audio-head">
          <strong className="audio-name" title={name}>
            {name}
          </strong>
          <span className="audio-facts">
            {factsText(mime, size)}
            {duration > 0 && ` · ${clock(duration)}`}
          </span>
        </div>
        <div className="audio-deck">
          <Tooltip content={`${paused ? "Play" : "Pause"} (Space)`}>
            <button
              type="button"
              className="audio-play"
              data-control="play"
              aria-label={paused ? "Play" : "Pause"}
              onClick={() => act("toggle")}
            >
              {paused ? (
                <Play size={20} strokeWidth={1.75} fill="currentColor" aria-hidden />
              ) : (
                <Pause size={20} strokeWidth={1.75} fill="currentColor" aria-hidden />
              )}
            </button>
          </Tooltip>
          <Waveform peaks={peaks} time={time} duration={duration} onSeek={seek} />
        </div>
        <div className="audio-bar">
          <span className="audio-time" aria-hidden>
            {clock(time, true)} / {clock(duration)}
          </span>
          <span className="audio-spacer" />
          <Control
            name="loop"
            icon={Repeat}
            label="Loop"
            tip="Loop (L)"
            pressed={loop}
            onClick={() => act("loop")}
          />
          <span className="audio-speed">
            <Tooltip content={`Playback speed: click for ${nextSpeed(speed)}×`}>
              <button
                type="button"
                className="icon-button video-control video-rate"
                data-control="speed"
                aria-label={`Speed ${speed}×`}
                onClick={() => media.setSpeed(nextSpeed(speed))}
              >
                {speed}×
              </button>
            </Tooltip>
          </span>
          <Control
            name="mute"
            icon={muted ? VolumeX : Volume2}
            label="Mute"
            tip={`${muted ? "Unmute" : "Mute"} (M)`}
            pressed={muted}
            onClick={() => act("mute")}
          />
        </div>
      </div>
      <audio
        ref={ref}
        preload="auto"
        loop={loop}
        muted={muted}
        aria-label={name}
        {...events}
        onError={onBroken}
      />
    </div>
  )
}
