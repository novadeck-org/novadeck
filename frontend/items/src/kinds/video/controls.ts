import { createKept } from "@novadeck/viewers"

// What the player's controls do, apart from the element they drive.

// How far the arrow keys jump, in seconds, and how long a frame is taken to be: the element
// tells no frame rate, so a step is a thirtieth of a second.
export const jump = 5
export const frame = 1 / 30

export const speeds = [0.5, 1, 1.5, 2] as const

// The speed a click on the speed control moves to: the next, round to the first.
export const nextSpeed = (speed: number): number =>
  speeds[(speeds.findIndex((each) => each === speed) + 1) % speeds.length] ?? 1

export type Action = "toggle" | "back" | "forward" | "before" | "after" | "loop" | "mute" | "full"

// The action a key stands for while the player has focus.
export const actionOf = (key: string): Action | undefined => {
  switch (key) {
    case " ":
      return "toggle"
    case "ArrowLeft":
      return "back"
    case "ArrowRight":
      return "forward"
    case ",":
      return "before"
    case ".":
      return "after"
    case "l":
    case "L":
      return "loop"
    case "m":
    case "M":
      return "mute"
    case "f":
    case "F":
      return "full"
    default:
      return undefined
  }
}

// A time held to the video: not before its start, not past its end where that is known.
export const within = (time: number, duration: number): number =>
  Math.min(Math.max(time, 0), Number.isFinite(duration) ? duration : Infinity)

// Where the person had left a video, by item: shown again, a pane that went and came back
// finds it as it was, and a show it already started at its `at` isn't started again.
export type Place = {
  readonly time: number
  readonly loop: boolean
  readonly speed: number
  readonly muted: boolean
  readonly shown: number
}

export const places = createKept<Place>(24)
