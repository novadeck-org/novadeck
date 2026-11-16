import type { AgentName } from "@novadeck/core/harnesses"
import { viewModes } from "@novadeck/core/state"
import type { ViewMode } from "@novadeck/core/types"
import { AntigravityIcon } from "@novadeck/toolkit/icons/AntigravityIcon"
import { ClaudeIcon } from "@novadeck/toolkit/icons/ClaudeIcon"
import { CodexIcon } from "@novadeck/toolkit/icons/CodexIcon"
import { views as layouts, type ViewPresentation } from "@novadeck/toolkit/views"
import { Check, Plug, Terminal } from "lucide-react"
import { useEffect, useId, useRef, useState, type ComponentType, type CSSProperties } from "react"

import { prefersReducedMotion } from "../interaction/reduced-motion"

// Each layout as the app shows it, with a line on what it is for.
const captions: Record<ViewMode, string> = {
  focus: "One terminal, full attention.",
  grid: "Everything side by side.",
  canvas: "Spread out on a zoomable canvas.",
}

type View = ViewPresentation & { readonly id: ViewMode; readonly caption: string }

const present = (id: ViewMode): View => ({ id, ...layouts[id], caption: captions[id] })
const views = viewModes.map(present)
const canvas = present("canvas")

// What the chat view's choice shows, as it changes.
const chatCaptions = {
  on: "Agents read as a chat: your words, their replies and steps.",
  off: "Agents keep their own terminal screens.",
}

// Until the person picks a layout, the preview shows each one in turn, once, and
// settles back on Canvas. Hovering or focusing the preview holds the current step.
const tour: readonly ViewMode[] = ["focus", "grid", "canvas"]
const tourStart = 3400
const tourStep = 3200

type Line = {
  readonly text: string
  readonly kind: "prompt" | "response" | "check"
}

const lineClasses: Record<Line["kind"], string> = {
  prompt: "prompt",
  response: "response",
  check: "check flex items-center gap-[5px]",
}

// Each terminal card's title bar and output; the stage's layout rules restyle the output.
const barClasses =
  "welcome-terminal-bar flex h-7 items-center gap-1.5 px-[9px] text-[8px] whitespace-nowrap"
const codeClasses = "welcome-code flex flex-col leading-[1.4] whitespace-nowrap"

// Each line types itself in after the terminals are dealt, `at` ms after opening.
const TypedLine = ({ text, kind, at }: Line & { readonly at: number }): React.JSX.Element => (
  <span
    className={`welcome-line welcome-typed w-fit ${lineClasses[kind]}`}
    style={
      { "--_chars": text.length + (kind === "check" ? 2 : 0), "--_at": `${at}ms` } as CSSProperties
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
  <span
    className="welcome-status ml-auto flex items-center gap-1.5"
    data-connected={connected === true || undefined}
  >
    {connected && (
      <span className="welcome-status-label flex items-center gap-[3px] text-[7px] leading-[normal]">
        <Plug size={7} strokeWidth={2.2} />
        connected
      </span>
    )}
    <span className="welcome-status-dot relative size-1" />
  </span>
)

// What each agent's card holds: the person's prompt, the agent's reply, and the steps it took,
// which its terminal shows as checks.
type AgentCard = {
  readonly agent: AgentName
  readonly className: string
  readonly icon: ComponentType<{ size?: number }>
  readonly title: string
  readonly harness: string
  readonly prompt: string
  readonly replies: readonly string[]
  readonly steps: readonly string[]
  // When its lines type in, ms after the dialog opens.
  readonly at: number
}

const agentCards: readonly AgentCard[] = [
  {
    agent: "claude",
    className: "agent",
    icon: ClaudeIcon,
    title: "Build something great",
    harness: "Claude Code",
    prompt: "Let’s bring this idea to life.",
    replies: ["I’ll start with the big picture."],
    steps: ["A place for every project", "Room for every possibility"],
    at: 1300,
  },
  {
    agent: "codex",
    className: "review",
    icon: CodexIcon,
    title: "A fresh perspective",
    harness: "Codex",
    prompt: "Review the changes",
    replies: ["A second pair of eyes,", "right beside your work."],
    steps: [],
    at: 1450,
  },
  {
    agent: "agy",
    className: "agy",
    icon: AntigravityIcon,
    title: "Planner",
    harness: "Antigravity",
    prompt: "Plan the release",
    replies: ["Every step, in order."],
    steps: [],
    at: 1750,
  },
]

// An agent's card as its terminal shows it: a prompt, the reply, the checks, and Claude's
// prompt waiting under them.
const TerminalOutput = ({ card, from }: { card: AgentCard; from: number }): React.JSX.Element => (
  <div className={codeClasses}>
    {typed(
      [
        { text: `❯ ${card.prompt}`, kind: "prompt" },
        ...card.replies.map((text) => ({ text, kind: "response" as const })),
        ...card.steps.map((text) => ({ text, kind: "check" as const })),
      ],
      from,
    )}
    {card.agent === "claude" && (
      <span
        className="welcome-cursor flex items-center gap-1.5"
        // Once the lines above it have typed in.
        style={{ "--_at": `${from + 1000}ms` } as CSSProperties}
      >
        ❯ <i className="block h-[9px] w-1" />
      </span>
    )}
  </div>
)

// The same card as the chat view draws it: the person's words by their mark, the reply by
// the agent's, its steps as dim lines on a rule, and the box to write in under a hairline.
const ChatOutput = ({ card, from }: { card: AgentCard; from: number }): React.JSX.Element => {
  const lines = [card.prompt, ...card.replies, ...card.steps]
  const at = (text: string): number => from + lines.indexOf(text) * 200
  const line = (text: string, className: string, mark?: boolean): React.JSX.Element => (
    <span
      key={text}
      className={`welcome-chat-line welcome-typed ${className}`}
      style={{ "--_chars": text.length + 2, "--_at": `${at(text)}ms` } as CSSProperties}
    >
      {mark && <i className="welcome-chat-mark" />}
      {text}
    </span>
  )
  return (
    <div className="welcome-chat flex min-h-0 flex-col" data-agent={card.agent}>
      <div className="welcome-chat-log flex min-h-0 flex-1 flex-col overflow-hidden">
        {line(card.prompt, "user", true)}
        {card.replies.map((text, index) => line(text, "reply", index === 0))}
        {card.steps.length > 0 && (
          <span className="welcome-chat-steps flex flex-col">
            {card.steps.map((text) => line(text, "step"))}
          </span>
        )}
      </div>
      <span className="welcome-chat-composer flex flex-none items-center">
        <i className="welcome-chat-mark" />
        Message {card.harness}…
      </span>
    </div>
  )
}

export const WelcomePreview = ({
  connected,
  chat = false,
  spotlight = false,
}: {
  readonly connected: Readonly<Record<AgentName, boolean>>
  // Whether agents' cards show as the chat view draws them, and whether the chat view's choice
  // is being looked at, which marks the cards it changes.
  readonly chat?: boolean
  readonly spotlight?: boolean
}): React.JSX.Element => {
  const [view, setView] = useState<View>(canvas)
  const [step, setStep] = useState<number | undefined>(() =>
    prefersReducedMotion() ? undefined : -1,
  )
  const [held, setHeld] = useState(false)
  // Once the chat view's choice changes, the caption tells what it changed, until a layout is
  // picked or shown, and the cards type their lines again at once rather than after the opening.
  const [chatChanged, setChatChanged] = useState(false)
  const [lastChat, setLastChat] = useState(chat)
  const [swapped, setSwapped] = useState(false)
  // Changing the choice ends the opening tour, as picking a layout does, so what it changed
  // stays said, and is announced.
  if (chat !== lastChat) {
    setLastChat(chat)
    setSwapped(true)
    setChatChanged(true)
    setStep(undefined)
  }
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
        if (id) setView(views.find((item) => item.id === id) ?? canvas)
        setStep(next)
        setChatChanged(false)
      },
      step === -1 ? tourStart : tourStep,
    )
    return () => window.clearTimeout(timer)
  }, [touring, held, step])

  const choose = (item: View): void => {
    setStep(undefined)
    setView(item)
    setChatChanged(false)
  }
  const captionText = chatChanged ? chatCaptions[chat ? "on" : "off"] : view.caption

  // The dot grid brightens around the pointer and Canvas terminals drift with it;
  // written straight to the stage so moving the pointer never re-renders the preview.
  const follow = (event: React.PointerEvent<HTMLDivElement>): void => {
    const element = stage.current
    if (!element) return
    const box = element.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    element.style.setProperty("--_mx", `${x}px`)
    element.style.setProperty("--_my", `${y}px`)
    element.style.setProperty("--_px", `${(x / box.width - 0.5) * 2}`)
    element.style.setProperty("--_py", `${(y / box.height - 0.5) * 2}`)
  }

  const settle = (): void => {
    stage.current?.style.setProperty("--_px", "0")
    stage.current?.style.setProperty("--_py", "0")
  }

  return (
    <section
      className="mt-6 flex min-h-0 flex-1 flex-col"
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
        className="welcome-stage relative isolate flex-1 overflow-hidden"
        data-view={view.id}
        data-spotlight={spotlight ? "chat" : undefined}
        aria-hidden="true"
        onPointerMove={follow}
        onPointerLeave={settle}
      >
        {agentCards.map((card) => {
          const Icon = card.icon
          const from = swapped ? 120 : card.at
          return (
            <div
              key={card.agent}
              className={`welcome-terminal ${card.className}`}
              data-chat={chat || undefined}
            >
              <div className={barClasses}>
                <Icon size={13} />
                <span>{card.title}</span>
                <Status connected={connected[card.agent]} />
              </div>
              {chat ? (
                <ChatOutput key="chat" card={card} from={from} />
              ) : (
                <TerminalOutput key="terminal" card={card} from={from} />
              )}
              {connected[card.agent] && <i className="welcome-scan" />}
            </div>
          )
        })}
        <div className="welcome-terminal server">
          <div className={barClasses}>
            <Terminal size={13} />
            <span>Dev server</span>
            <Status />
          </div>
          <div className={codeClasses}>
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
        <div className="welcome-zoom absolute bottom-[9px] left-3 flex gap-3 text-[8px] leading-[normal]">
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
              data-state={active ? "on" : "off"}
              onClick={() => choose(item)}
              className="segment relative flex min-h-9 items-center gap-2 overflow-hidden px-3 py-2 text-control"
            >
              <Icon size={13} strokeWidth={1.6} aria-hidden="true" />
              {item.label}
              {active && touring && step >= 0 && !held && (
                <span
                  key={step}
                  className="welcome-progress absolute right-2 bottom-0 left-2 h-px origin-left"
                  style={{ "--_step": `${tourStep}ms` } as CSSProperties}
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
        <p key={captionText} className="welcome-caption m-0 text-body text-balance">
          {captionText}
        </p>
      </div>
    </section>
  )
}
