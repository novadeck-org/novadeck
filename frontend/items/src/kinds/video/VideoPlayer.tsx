import { Tooltip } from "@novadeck/toolkit/Tooltip"
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  Repeat,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Control } from "./Control"
import { actionOf, frame, jump, nextSpeed, type Action } from "./controls"
import { clock } from "./format"
import { useMedia } from "./useMedia"

// A video played with its own bar: play, scrubber, time, frame steps, loop, speed, mute and
// full screen, which the keys of a player in focus reach too. The video is letterboxed on a
// dark ground. What it does with the element (swapping a rewritten file in, remembering where
// it was left, starting at a show's second) is `useMedia`'s.
export const VideoPlayer = ({
  id,
  src,
  name,
  shown,
  at,
  onBroken,
}: {
  id: string
  src: string
  name: string
  shown: number
  at: number | undefined
  // The browser can't play it: its bytes aren't a video it can decode.
  onBroken: () => void
}): React.JSX.Element => {
  const box = useRef<HTMLDivElement>(null)
  const media = useMedia<HTMLVideoElement>({ id, src, shown, at })
  const { ref, paused, time, duration, loop, speed, muted, seek, events } = media
  const [full, setFull] = useState(false)

  useEffect(() => {
    const changed = (): void => setFull(document.fullscreenElement === box.current)
    document.addEventListener("fullscreenchange", changed)
    return () => document.removeEventListener("fullscreenchange", changed)
  }, [])

  const step = (by: number): void => {
    const element = ref.current!
    element.pause()
    seek(element.currentTime + by)
  }
  const act = (action: Action): void => {
    const element = ref.current!
    switch (action) {
      case "toggle":
        return media.toggle()
      case "back":
        return seek(element.currentTime - jump)
      case "forward":
        return seek(element.currentTime + jump)
      case "before":
        return step(-frame)
      case "after":
        return step(frame)
      case "loop":
        return media.setLoop((on) => !on)
      case "mute":
        return media.setMuted((on) => !on)
      case "full":
        if (document.fullscreenElement === box.current) void document.exitFullscreen()
        else void box.current?.requestFullscreen?.()
    }
  }

  return (
    <div
      ref={box}
      className="video-player"
      tabIndex={0}
      data-own-keys=""
      role="group"
      aria-label={`Video ${name}`}
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
      <video
        ref={ref}
        className="video-picture"
        playsInline
        preload="auto"
        loop={loop}
        muted={muted}
        aria-label={name}
        onClick={() => act("toggle")}
        {...events}
        onError={onBroken}
      />
      <div className="video-bar">
        <input
          type="range"
          className="video-scrub"
          aria-label="Seek"
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
          min={0}
          max={duration || 1}
          step="any"
          value={Math.min(time, duration || 1)}
          style={
            {
              "--_played": `${duration ? (Math.min(time, duration) / duration) * 100 : 0}%`,
            } as React.CSSProperties
          }
          disabled={duration === 0}
          onChange={(event) => seek(event.currentTarget.valueAsNumber)}
        />
        <div className="video-buttons">
          <Control
            name="play"
            icon={paused ? Play : Pause}
            label={paused ? "Play" : "Pause"}
            tip={`${paused ? "Play" : "Pause"} (Space)`}
            onClick={() => act("toggle")}
          />
          <span className="video-step">
            <Control
              name="before"
              icon={StepBack}
              label="Back one frame"
              tip="Back one frame (,)"
              onClick={() => act("before")}
            />
            <Control
              name="after"
              icon={StepForward}
              label="Forward one frame"
              tip="Forward one frame (.)"
              onClick={() => act("after")}
            />
          </span>
          <span className="video-time" aria-hidden>
            {clock(time, true)} / {clock(duration)}
          </span>
          <span className="video-spacer" />
          <Control
            name="loop"
            icon={Repeat}
            label="Loop"
            tip="Loop (L)"
            pressed={loop}
            onClick={() => act("loop")}
          />
          <span className="video-speed">
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
          <Control
            name="full"
            icon={full ? Minimize : Maximize}
            label={full ? "Exit full screen" : "Full screen"}
            tip={`${full ? "Exit full screen" : "Full screen"} (F)`}
            onClick={() => act("full")}
          />
        </div>
      </div>
    </div>
  )
}
