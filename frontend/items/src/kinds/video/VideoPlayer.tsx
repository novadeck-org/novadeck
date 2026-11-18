import { useShown } from "@novadeck/toolkit/shown"
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
  type LucideIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import {
  actionOf,
  frame,
  jump,
  nextSpeed,
  places,
  within,
  type Action,
  type Place,
} from "./controls"
import { clock } from "./format"

// A control of the bar: an icon button with its tooltip, as the pane's tools are.
const Control = ({
  icon: Icon,
  label,
  tip,
  onClick,
  pressed,
  name,
}: {
  icon: LucideIcon
  label: string
  tip: string
  onClick: () => void
  pressed?: boolean
  name: string
}): React.JSX.Element => (
  <Tooltip content={tip}>
    <button
      type="button"
      className="icon-button video-control"
      data-control={name}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden />
    </button>
  </Tooltip>
)

const play = (video: HTMLVideoElement): void => {
  // A play the page isn't allowed to start, or one that a new source cut short, is no news.
  void Promise.resolve(video.play()).catch(() => {})
}

// A video played with its own bar: play, scrubber, time, frame steps, loop, speed, mute and
// full screen, which the keys of a player in focus reach too. The video is letterboxed on a
// dark ground. A new `src` (the file was rewritten) swaps in where the old one was, playing or
// paused; where its item was left, its time and settings, is kept for when it's shown again,
// and each later show of it that names a second (`at`) starts it there.
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
  const video = useRef<HTMLVideoElement>(null)
  const [place] = useState(() => places.get(id))
  const [paused, setPaused] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loop, setLoop] = useState(place?.loop ?? false)
  const [speed, setSpeed] = useState(place?.speed ?? 1)
  const [muted, setMuted] = useState(place?.muted ?? false)
  const [full, setFull] = useState(false)
  // The latest show whose start was applied: the show the place was left at, or none yet.
  const started = useRef(place?.shown ?? 0)

  // What it keeps for when it comes back.
  const latest = useRef<Place>({ time: place?.time ?? 0, loop, speed, muted, shown })
  const sync = (): void => {
    const element = video.current
    if (!element) return
    setPaused(element.paused)
    setTime(element.currentTime)
    latest.current = { ...latest.current, time: element.currentTime }
    setDuration(Number.isFinite(element.duration) ? element.duration : 0)
  }

  // The source is set here, not by the element's attribute, to read where the old one was
  // before the new one empties the element: it resumes there once it knows its length.
  useEffect(() => {
    const element = video.current!
    const swapped = element.getAttribute("src") !== null
    const resume = swapped
      ? { time: element.currentTime, playing: !element.paused }
      : { time: place?.time ?? 0, playing: false }
    const loaded = (): void => {
      element.currentTime = within(resume.time, element.duration)
      if (resume.playing) play(element)
    }
    element.addEventListener("loadedmetadata", loaded, { once: true })
    element.src = src
    return () => element.removeEventListener("loadedmetadata", loaded)
  }, [src, place])

  // The default rate is what a new source starts at, so a swap keeps the speed.
  useEffect(() => {
    const element = video.current!
    element.defaultPlaybackRate = speed
    element.playbackRate = speed
  }, [speed])

  // A show that names a second starts there, once, when the video knows its length.
  useEffect(() => {
    const element = video.current!
    if (duration === 0 || shown <= started.current) return
    started.current = shown
    if (at !== undefined) element.currentTime = within(at, element.duration)
  }, [shown, at, duration])

  useEffect(() => {
    latest.current = { ...latest.current, loop, speed, muted }
  })
  useEffect(
    () => () => {
      places.keep(id, { ...latest.current, shown: started.current })
    },
    [id],
  )

  // The scrubber follows the picture, not the element's few reports a second.
  useEffect(() => {
    if (paused) return
    const element = video.current!
    let frameId = requestAnimationFrame(function tick() {
      setTime(element.currentTime)
      frameId = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frameId)
  }, [paused])

  // Out of sight, it stops.
  const visible = useShown()
  useEffect(() => {
    if (!visible) video.current?.pause()
  }, [visible])

  useEffect(() => {
    const changed = (): void => setFull(document.fullscreenElement === box.current)
    document.addEventListener("fullscreenchange", changed)
    return () => document.removeEventListener("fullscreenchange", changed)
  }, [])

  const seek = (to: number): void => {
    const element = video.current!
    element.currentTime = within(to, element.duration)
    setTime(element.currentTime)
  }
  const step = (by: number): void => {
    const element = video.current!
    element.pause()
    seek(element.currentTime + by)
  }
  const act = (action: Action): void => {
    const element = video.current!
    switch (action) {
      case "toggle":
        if (element.paused) play(element)
        else element.pause()
        return
      case "back":
        return seek(element.currentTime - jump)
      case "forward":
        return seek(element.currentTime + jump)
      case "before":
        return step(-frame)
      case "after":
        return step(frame)
      case "loop":
        return setLoop((on) => !on)
      case "mute":
        return setMuted((on) => !on)
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
        ref={video}
        className="video-picture"
        playsInline
        preload="auto"
        loop={loop}
        muted={muted}
        aria-label={name}
        onClick={() => act("toggle")}
        onPlay={sync}
        onPause={sync}
        onEnded={sync}
        onSeeked={sync}
        onTimeUpdate={sync}
        onError={onBroken}
        onLoadedMetadata={sync}
        onDurationChange={sync}
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
                onClick={() => setSpeed(nextSpeed(speed))}
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
