import { Check, Columns2, Grid2X2, Maximize, Plug, Terminal } from "lucide-react"
import { useEffect, useId, useRef, useState, type CSSProperties } from "react"

import { ClaudeIcon } from "../ui-toolkit/icons/ClaudeIcon"
import { CodexIcon } from "../ui-toolkit/icons/CodexIcon"

import styles from "./OnboardingPreview.module.css"

const views = [
  {
    id: "focus",
    label: "Focus",
    icon: Columns2,
    caption: "One terminal, full attention.",
  },
  {
    id: "grid",
    label: "Grid",
    icon: Grid2X2,
    caption: "Everything side by side.",
  },
  {
    id: "canvas",
    label: "Canvas",
    icon: Maximize,
    caption: "Spread out on a zoomable canvas.",
  },
] as const

type View = (typeof views)[number]

// Until the person picks a layout, the preview shows each one in turn, once, and
// settles back on Canvas. Hovering or focusing the preview holds the current step.
const tour: readonly View["id"][] = ["focus", "grid", "canvas"]
const tourStart = 3400
const tourStep = 3200

type Line = {
  readonly text: string
  readonly kind: "prompt" | "response" | "check"
}

// Each line types itself in after the terminals are dealt, `at` ms after opening.
const TypedLine = ({ text, kind, at }: Line & { readonly at: number }): React.JSX.Element => (
  <span
    className={`${styles.typed} ${styles[kind]}`}
    style={
      { "--chars": text.length + (kind === "check" ? 2 : 0), "--at": `${at}ms` } as CSSProperties
    }
  >
    {kind === "check" && <Check size={10} />}
    {text}
  </span>
)

const typed = (lines: readonly Line[], from: number): React.JSX.Element[] =>
  lines.map((line, index) => <TypedLine key={line.text} {...line} at={from + index * 200} />)

// A connected agent's terminal says so, and plays a short scan the moment it connects.
const Status = ({ connected }: { readonly connected?: boolean }): React.JSX.Element => (
  <span className={styles.status} data-connected={connected === true || undefined}>
    {connected && (
      <span className={styles.connected}>
        <Plug size={7} strokeWidth={2.2} />
        connected
      </span>
    )}
    <span className={styles.dot} />
  </span>
)

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches

export const OnboardingPreview = ({
  connected,
}: {
  readonly connected: { readonly claude: boolean; readonly codex: boolean }
}): React.JSX.Element => {
  const [view, setView] = useState<View>(views[2])
  const [step, setStep] = useState<number | undefined>(() => (reducedMotion() ? undefined : -1))
  const [held, setHeld] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const caption = useId()
  // The tour ends as it reaches its last layout.
  const touring = step !== undefined && step < tour.length - 1

  useEffect(() => {
    if (!touring || held) return
    const timer = window.setTimeout(
      () => {
        const next = step + 1
        const id = tour[next]
        if (id) setView(views.find((item) => item.id === id) ?? views[2])
        setStep(next)
      },
      step === -1 ? tourStart : tourStep,
    )
    return () => window.clearTimeout(timer)
  }, [touring, held, step])

  const choose = (item: View): void => {
    setStep(undefined)
    setView(item)
  }

  // The dot grid brightens around the pointer and Canvas terminals drift with it;
  // written straight to the stage so moving the pointer never re-renders the preview.
  const follow = (event: React.PointerEvent<HTMLDivElement>): void => {
    const element = stage.current
    if (!element) return
    const box = element.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    element.style.setProperty("--mx", `${x}px`)
    element.style.setProperty("--my", `${y}px`)
    element.style.setProperty("--px", `${(x / box.width - 0.5) * 2}`)
    element.style.setProperty("--py", `${(y / box.height - 0.5) * 2}`)
  }

  const settle = (): void => {
    stage.current?.style.setProperty("--px", "0")
    stage.current?.style.setProperty("--py", "0")
  }

  return (
    <section
      className="mt-6"
      aria-label="Explore your workspace"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false)
      }}
    >
      <div
        ref={stage}
        className={styles.stage}
        data-view={view.id}
        aria-hidden="true"
        onPointerMove={follow}
        onPointerLeave={settle}
      >
        <div className={`${styles.terminal} ${styles.agent}`}>
          <div className={styles.bar}>
            <ClaudeIcon size={13} />
            <span>Build something great</span>
            <Status connected={connected.claude} />
          </div>
          <div className={styles.code}>
            {typed(
              [
                { text: "❯ Let’s bring this idea to life.", kind: "prompt" },
                { text: "I’ll start with the big picture.", kind: "response" },
                { text: "A place for every project", kind: "check" },
                { text: "Room for every possibility", kind: "check" },
              ],
              1300,
            )}
            <span className={styles.cursor}>
              ❯ <i />
            </span>
          </div>
          {connected.claude && <i className={styles.scan} />}
        </div>
        <div className={`${styles.terminal} ${styles.review}`}>
          <div className={styles.bar}>
            <CodexIcon size={13} />
            <span>A fresh perspective</span>
            <Status connected={connected.codex} />
          </div>
          <div className={styles.code}>
            {typed(
              [
                { text: "❯ Review the changes", kind: "prompt" },
                { text: "A second pair of eyes,", kind: "response" },
                { text: "right beside your work.", kind: "response" },
              ],
              1450,
            )}
          </div>
          {connected.codex && <i className={styles.scan} />}
        </div>
        <div className={`${styles.terminal} ${styles.server}`}>
          <div className={styles.bar}>
            <Terminal size={13} />
            <span>Dev server</span>
            <Status />
          </div>
          <div className={styles.code}>
            {typed(
              [
                { text: "$ pnpm dev", kind: "prompt" },
                { text: "Ready when you are.", kind: "check" },
                { text: "localhost:5173", kind: "response" },
              ],
              1600,
            )}
          </div>
        </div>
        <div className={styles.scale}>
          − <span>{view.id === "canvas" ? "75%" : "100%"}</span> +
        </div>
      </div>

      <div
        className="mt-4 flex items-center justify-center gap-1"
        role="group"
        aria-label="Preview workspace layout"
        aria-describedby={caption}
      >
        {views.map((item) => {
          const Icon = item.icon
          const active = view.id === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => choose(item)}
              className={`relative flex min-h-9 items-center gap-2 overflow-hidden rounded-control border px-3 py-2 text-[11px] transition-[background-color,border-color,color,box-shadow] duration-(--motion-state) ${active ? "border-line-strong bg-paper text-ink shadow-control" : "border-transparent text-muted hover:bg-soft hover:text-ink"}`}
            >
              <Icon size={13} strokeWidth={1.6} aria-hidden="true" />
              {item.label}
              {active && touring && step >= 0 && !held && (
                <span
                  key={step}
                  className={styles.progress}
                  style={{ "--step": `${tourStep}ms` } as CSSProperties}
                  aria-hidden="true"
                />
              )}
            </button>
          )
        })}
      </div>
      {/* Captions announce only the layouts the person picks, not the opening tour. */}
      <div
        id={caption}
        className="mt-3 text-center"
        aria-live={touring ? "off" : "polite"}
        aria-atomic="true"
      >
        <p key={view.id} className={`m-0 text-[12px] text-muted ${styles.caption}`}>
          {view.caption}
        </p>
      </div>
    </section>
  )
}
