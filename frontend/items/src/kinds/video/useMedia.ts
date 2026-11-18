import { useShown } from "@novadeck/toolkit/shown"
import { useEffect, useRef, useState } from "react"

import { places, within, type Place } from "./controls"

// A media element's play, for a page that isn't allowed to start it, or one that a new source
// cut short, is no news.
export const play = (element: HTMLMediaElement): void => {
  void Promise.resolve(element.play()).catch(() => {})
}

// A show as a player has it: its count, the second it names, and whether the source playing is
// the file it names.
type Show = { readonly shown: number; readonly at: number | undefined; readonly current: boolean }

// The second a show not yet applied (later than `started`) starts at, marking it applied, where
// the source playing is the file it names; none where it names no second, or there is no such
// show.
const begin = (show: Show, started: { current: number }): number | undefined => {
  if (!show.current || show.shown <= started.current) return undefined
  started.current = show.shown
  return show.at
}

// What a video or a recording player does with the element it drives, which only what it
// draws differs in: where the element is, in what state (paused, time, length, loop, speed,
// mute), and the handlers that keep that state as the element's. A new `src` (the file was
// rewritten) swaps in where the old one was, playing or paused; where its item was left, its
// time and settings, is kept for when it's shown again, and each later show of it that names
// a second (`at`) starts it there: the file that show names (`current`), not the one before,
// which plays on while the new one is read.
export const useMedia = <Element extends HTMLMediaElement>({
  id,
  src,
  shown,
  at,
  current,
}: {
  id: string
  src: string
  shown: number
  at: number | undefined
  current: boolean
}) => {
  const ref = useRef<Element>(null)
  const [place] = useState(() => places.get(id))
  const [paused, setPaused] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loop, setLoop] = useState(place?.loop ?? false)
  const [speed, setSpeed] = useState(place?.speed ?? 1)
  const [muted, setMuted] = useState(place?.muted ?? false)
  // The latest show whose start was applied: the show the place was left at, or none yet.
  const started = useRef(place?.shown ?? 0)
  // The show as it is now, for a source that knows its length later than it was set.
  const show = useRef<Show>({ shown, at, current })
  useEffect(() => {
    show.current = { shown, at, current }
  })

  // What it keeps for when it comes back.
  const latest = useRef<Place>({ time: place?.time ?? 0, loop, speed, muted, shown })
  const sync = (): void => {
    const element = ref.current
    if (!element) return
    setPaused(element.paused)
    setTime(element.currentTime)
    latest.current = { ...latest.current, time: element.currentTime }
    setDuration(Number.isFinite(element.duration) ? element.duration : 0)
  }

  // The source is set here, not by the element's attribute, to read where the old one was
  // before the new one empties the element: it resumes there once it knows its length.
  useEffect(() => {
    const element = ref.current!
    const swapped = element.getAttribute("src") !== null
    const resume = swapped
      ? { time: element.currentTime, playing: !element.paused }
      : { time: place?.time ?? 0, playing: false }
    // A show that names a second of this file starts there, else it resumes.
    const loaded = (): void => {
      element.currentTime = within(begin(show.current, started) ?? resume.time, element.duration)
      if (resume.playing) play(element)
    }
    element.addEventListener("loadedmetadata", loaded, { once: true })
    element.src = src
    return () => element.removeEventListener("loadedmetadata", loaded)
  }, [src, place])

  // The default rate is what a new source starts at, so a swap keeps the speed.
  useEffect(() => {
    const element = ref.current!
    element.defaultPlaybackRate = speed
    element.playbackRate = speed
  }, [speed])

  // A show that names a second starts there, once, where the element knows its length; one that
  // doesn't yet (a new file is loading) starts there once it does.
  useEffect(() => {
    const element = ref.current!
    if (Number.isNaN(element.duration)) return
    const to = begin({ shown, at, current }, started)
    if (to !== undefined) element.currentTime = within(to, element.duration)
  }, [shown, at, current])

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
    const element = ref.current!
    let frameId = requestAnimationFrame(function tick() {
      setTime(element.currentTime)
      frameId = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frameId)
  }, [paused])

  // Out of sight, it stops.
  const visible = useShown()
  useEffect(() => {
    if (!visible) ref.current?.pause()
  }, [visible])

  const seek = (to: number): void => {
    const element = ref.current!
    element.currentTime = within(to, element.duration)
    setTime(element.currentTime)
  }
  const toggle = (): void => {
    const element = ref.current!
    if (element.paused) play(element)
    else element.pause()
  }

  return {
    ref,
    paused,
    time,
    duration,
    loop,
    speed,
    muted,
    setLoop,
    setSpeed,
    setMuted,
    seek,
    toggle,
    // The element's events that tell its state.
    events: {
      onPlay: sync,
      onPause: sync,
      onEnded: sync,
      onSeeked: sync,
      onTimeUpdate: sync,
      onLoadedMetadata: sync,
      onDurationChange: sync,
    },
  }
}
