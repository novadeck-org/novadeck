import { AntigravityIcon } from "@novadeck/toolkit/icons/AntigravityIcon"
import { ClaudeIcon } from "@novadeck/toolkit/icons/ClaudeIcon"
import { CodexIcon } from "@novadeck/toolkit/icons/CodexIcon"
import { Terminal } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"

import { clocksOf, handleParts, hueOf, imp, impClocks, spriteOf, type Clocks } from "./critters"
import { deviceScale, onScaleChange } from "./device-scale"
import { allCells, cellsPath, hopped, ledGrid, tonesOf, type LedGrid } from "./led"

// Whether a handle's agent is there: at rest, working (its critter hops), or gone from its
// terminal (still and dim).
export type AvatarLive = "idle" | "working" | "gone"

// The program's mark in the avatar's corner, by the program's name.
const programIcons: Readonly<Record<string, typeof Terminal>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  agy: AntigravityIcon,
}

// The screen's scale, measured on the avatar once it's laid out and again whenever it may
// have changed, so its LEDs stay on whole device pixels.
const useDeviceScale = (element: React.RefObject<HTMLElement | null>): number => {
  const [scale, setScale] = useState(() =>
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  )
  useLayoutEffect(() => {
    const measure = (): void => {
      if (element.current) setScale(deviceScale(element.current))
    }
    measure()
    return onScaleChange(measure)
  }, [element])
  return scale
}

const timing = (clocks: Clocks): CSSProperties =>
  ({
    "--_blink": `${clocks.blink}s`,
    "--_blink-at": `${clocks.blinkAt}s`,
    "--_hop": `${clocks.hop}s`,
    "--_hop-at": `${clocks.hopAt}s`,
  }) as CSSProperties

const Path = ({
  grid,
  cells,
  className,
}: {
  grid: LedGrid
  cells: readonly (readonly [number, number])[]
  className: string
}): React.JSX.Element | null =>
  cells.length ? <path className={className} d={cellsPath(grid, cells)} /> : null

// A critter's frame: its lit, dim and bright cells, its dark eyes with the lids that close
// them, and its bright eyes, which go out as it blinks.
const Frame = ({
  grid,
  sprite,
  className,
}: {
  grid: LedGrid
  sprite: readonly string[]
  className: string
}): React.JSX.Element => {
  const tones = tonesOf(sprite)
  return (
    <g className={className}>
      <Path grid={grid} cells={tones["#"]} className="message-led-on" />
      <Path grid={grid} cells={tones["+"]} className="message-led-dim" />
      <Path grid={grid} cells={tones.o} className="message-led-hot" />
      <Path grid={grid} cells={tones.x} className="message-led-eye" />
      <Path grid={grid} cells={tones.x} className="message-led-on message-led-lid" />
      <Path grid={grid} cells={tones.e} className="message-led-bright" />
    </g>
  )
}

// The person: the screen lit behind a dark silhouette, its eyes glowing.
const Imp = ({ grid }: { grid: LedGrid }): React.JSX.Element => {
  const tones = tonesOf(imp)
  const taken = new Set([...tones["#"], ...tones.g].map(([x, y]) => `${x},${y}`))
  return (
    <>
      <Path
        grid={grid}
        cells={allCells.filter(([x, y]) => !taken.has(`${x},${y}`))}
        className="message-led-back"
      />
      <Path grid={grid} cells={tones["#"]} className="message-led-eye" />
      <Path grid={grid} cells={tones.g} className="message-led-glow" />
    </>
  )
}

// A handle's avatar, only in the Messages pane: its word's critter lit on a small dark LED
// screen in the word's hue, the number a later round gives the word in its corner, and,
// where it has room, the program its agent runs. The person (`person`) is a backlit imp.
export const Avatar = ({
  handle,
  person = false,
  size,
  live = "idle",
  program,
}: {
  handle: string
  // The person's, whatever `handle` says.
  person?: boolean
  // Its side, in CSS pixels.
  size: number
  live?: AvatarLive
  // The program in its terminal, for the mark in its corner from 24 pixels up.
  program?: string | undefined
}): React.JSX.Element => {
  const element = useRef<HTMLSpanElement>(null)
  const scale = useDeviceScale(element)
  const grid = ledGrid(size, scale)
  const you = person
  const sprite = useMemo(() => (you ? imp : spriteOf(handle)), [you, handle])
  const hop = useMemo(() => hopped(sprite), [sprite])
  const { numeral } = handleParts(handle)
  const Program = program === undefined ? undefined : (programIcons[program] ?? Terminal)
  return (
    <span
      ref={element}
      className="message-av"
      data-hue={you ? "you" : hueOf(handle)}
      data-live={you ? "idle" : live}
      data-big={size >= 28 || undefined}
      style={
        { "--av": `${size}px`, ...timing(you ? impClocks : clocksOf(handle)) } as CSSProperties
      }
      aria-hidden="true"
    >
      <svg
        className="message-av-screen"
        viewBox={`0 0 ${grid.device} ${grid.device}`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
      >
        {you ? (
          <Imp grid={grid} />
        ) : (
          <>
            <Path grid={grid} cells={allCells} className="message-led-off" />
            <Frame grid={grid} sprite={sprite} className="message-av-rest" />
            <Frame grid={grid} sprite={hop} className="message-av-hop" />
          </>
        )}
      </svg>
      {numeral && !you && <b className="message-av-n">{numeral}</b>}
      {Program && size >= 24 && (
        <span className="message-av-program">
          <Program size={10} strokeWidth={1.75} />
        </span>
      )}
    </span>
  )
}
