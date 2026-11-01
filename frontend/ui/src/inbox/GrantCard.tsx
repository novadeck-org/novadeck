/* oxlint-disable react/no-array-index-key -- Commands have no ids; the lists never reorder. */
import {
  askedFor,
  commandWords,
  grantBody,
  grantExtras,
  grantTitle,
  lifetimeWords,
  proposedRepos,
  type GrantCommand,
  type GrantLifetime,
  type GrantProposal,
} from "@novadeck/core/grants"
import type { InboxRow } from "@novadeck/core/inbox"
import { visibleText } from "@novadeck/core/visible-text"
import { Checkbox } from "@novadeck/toolkit/Checkbox"
import { Switch } from "@novadeck/toolkit/Switch"
import { useId, useLayoutEffect, useRef, useState } from "react"

import { AutoRunNote } from "./AutoRunFix"
import type { SheetContentProps } from "./ConsoleSheet"
import { useInboxContext } from "./InboxProvider"
import { Menu, type MenuHandle, type MenuItem } from "./Menu"
import { Disclosure, Heading } from "./sheet-parts"

// The cards that make a grant (#587, #588), in Novadeck's own words, composed from the fixed
// parts of what is asked: the presets, the repos, the commands and who is covered. The agent's
// own words are never in them: the lead's reason sits under them as a muted note, and a command
// is code. Only the person's click makes a grant.

const repoName = (url: string): string => url.replace(/^github\.com\//, "")

// A list with an item in it, or out of it.
const toggle = <T,>(list: readonly T[], item: T, on: boolean): T[] =>
  on ? [...list.filter((each) => each !== item), item] : list.filter((each) => each !== item)

const handlesOf = (list: readonly { readonly handle: string }[]): string =>
  list.map(({ handle }) => `@${handle}`).join(", ")

// A granted command as plain code: its shell-quoted words.
const CommandCode = ({ command }: { readonly command: GrantCommand }): React.JSX.Element => (
  <code>{commandWords(command).join(" ")}</code>
)

// How much of the agent's words show before "more".
const noteLength = 280

// The agent's own words under Novadeck's, as a muted note: plain text whatever marks it holds,
// clamped to one line with a toggle where it runs longer, and named for a screen reader as
// what the agent says.
export const AgentNote = ({
  text,
  who,
}: {
  readonly text: string
  readonly who: string
}): React.JSX.Element | null => {
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  const note = useRef<HTMLParagraphElement>(null)
  const id = useId()
  // The words as they read, with what nothing shows written out; about 280 characters of them
  // until "more".
  const shown = visibleText(text)
  const clipped = !open && shown.length > noteLength
  useLayoutEffect(() => {
    const el = note.current
    if (!el || open) return
    const measure = (): void => setOver(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [open])
  if (text.trim() === "") return null
  const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-control)" }
  return (
    <>
      {/* Novadeck's own line says whose words these are; they follow in mono, plain. */}
      <p className="console-note" data-reason-intro="">
        @{who}&apos;s reason:
      </p>
      <p
        ref={note}
        id={id}
        className="console-note"
        role="note"
        aria-label={`What @${who} says`}
        style={
          open
            ? { ...mono, marginTop: -8 }
            : {
                ...mono,
                marginTop: -8,
                display: "-webkit-box",
                WebkitLineClamp: 1,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
        }
      >
        {clipped ? `${shown.slice(0, noteLength)}…` : shown}
      </p>
      {(over || clipped || (open && shown.length > noteLength)) && (
        <button
          type="button"
          className="button link inbox-link text-control"
          style={{ marginLeft: 16, marginTop: -6, alignSelf: "flex-start" }}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {open ? "less" : "more"}
        </button>
      )}
    </>
  )
}

// A Grant card's title, what they'd do and the lead's reason. The person's switch and ticks
// change who and where, so the title and body follow them.
export const GrantTop = ({
  proposal,
  lead,
  withLead = proposal.withLead,
  ticked = proposedRepos(proposal),
}: {
  readonly proposal: GrantProposal
  readonly lead: string
  readonly withLead?: boolean
  readonly ticked?: readonly string[]
}): React.JSX.Element => (
  <>
    <Heading glyph="!">{grantTitle(proposal, lead, withLead)}</Heading>
    <div className="console-body">
      <div className="markdown">
        <p style={{ margin: 0 }}>
          {grantBody(proposal, ticked).map((part, index) =>
            "code" in part ? <code key={index}>{part.code}</code> : part.text,
          )}
        </p>
      </div>
    </div>
    <AgentNote text={proposal.reason} who={lead} />
  </>
)

// An approval ask's commands under Novadeck's sentence for them, as code lines, then the
// agent's own words as a muted note. What is open ended, or runs outside a sandbox, is a line
// in warning text.
export const ApprovalWords = ({
  row,
  commands,
  body,
}: {
  readonly row: InboxRow
  readonly commands: readonly GrantCommand[]
  readonly body: string
}): React.JSX.Element => {
  const open = commands.filter(({ rest }) => rest)
  return (
    <>
      <div className="console-body">
        <div className="markdown">
          <p style={{ margin: 0 }}>I&apos;d run these without asking you each time:</p>
        </div>
      </div>
      <ul className="grant-lines" aria-label="Commands" style={{ marginLeft: 16 }}>
        {commands.map((command, index) => (
          <li key={index}>
            <CommandCode command={command} />
          </li>
        ))}
      </ul>
      <AgentNote text={body} who={row.source.handle} />
      {open.length > 0 && (
        <p className="grant-warn" style={{ marginLeft: 16 }} data-grant="rest">
          {open.map((command, index) => (
            <span key={index}>
              {index > 0 && ", "}
              <code>{commandWords(command).join(" ")}</code>
            </span>
          ))}{" "}
          could be followed by anything.
        </p>
      )}
      {row.source.agent === "codex" && (
        <p className="grant-warn" style={{ marginLeft: 16 }} data-grant="codex">
          @{row.source.handle} uses Codex: allowed commands run outside Codex&apos;s sandbox.
        </p>
      )}
    </>
  )
}

// The things the lead asked for beyond the presets, behind Review: each unticked, with why it
// needs the person's OK in warning text.
const Review = ({
  id,
  proposal,
  commands,
  repos,
  disabled,
  onCommand,
  onRepo,
}: {
  readonly id: string
  readonly proposal: GrantProposal
  readonly commands: readonly number[]
  readonly repos: readonly string[]
  readonly disabled: boolean
  readonly onCommand: (at: number, on: boolean) => void
  readonly onRepo: (url: string, on: boolean) => void
}): React.JSX.Element => (
  <fieldset className="grant-group" id={id}>
    <legend>Needs your OK</legend>
    <p className="console-note" style={{ marginLeft: 0 }}>
      Not included unless you tick them.
    </p>
    {grantExtras(proposal).map((extra) =>
      extra.kind === "command" ? (
        <Tick
          key={`c${extra.at}`}
          checked={commands.includes(extra.at)}
          disabled={disabled}
          onChange={(on) => onCommand(extra.at, on)}
        >
          <span className="grant-repo">
            Also run <CommandCode command={proposal.commands[extra.at]!} />
            {proposal.commands[extra.at]!.rest && " with any arguments"}
            <span className="grant-warn">{extra.reason}</span>
          </span>
        </Tick>
      ) : (
        <Tick
          key={extra.url}
          checked={repos.includes(extra.url)}
          disabled={disabled}
          onChange={(on) => onRepo(extra.url, on)}
        >
          <span className="grant-repo">
            Push to <code>{repoName(extra.url)}</code>
            <span className="grant-warn">{extra.reason}</span>
          </span>
        </Tick>
      ),
    )}
  </fieldset>
)

// The ways to answer a lead's Grant card: with what the person ticked under Review.
type Answer = "until-done" | "hour" | "decline" | "terminal"

// A lead's Grant card, under its title and words (`GrantWords`): the extras it asked for, the
// details of who is covered, and the menu that answers it. The presets and the repos it ticks
// are as proposed; the person ticks what else they allow, and the option they press carries
// how long it lasts.
export const GrantCard = ({
  props,
  proposal,
  handle,
  arrived,
}: {
  readonly props: SheetContentProps
  readonly proposal: GrantProposal
  readonly handle: React.Ref<MenuHandle>
  readonly arrived: boolean
}): React.JSX.Element => {
  const { row, answering, submit, reveal } = props
  const { dismiss } = useInboxContext()
  const lead = row.source.handle
  const [reviewing, setReviewing] = useState(false)
  // Nothing the lead asked for beyond the proposed repos is ticked until the person ticks it.
  const [commands, setCommands] = useState<readonly number[]>([])
  const [repos, setRepos] = useState<readonly string[]>(proposedRepos(proposal))
  const [withLead, setWithLead] = useState(proposal.withLead)
  const [pressed, setPressed] = useState<number | null>(null)
  const me = useId()
  const review = useId()
  const extras = grantExtras(proposal)
  const codex = proposal.covered.filter(({ agent }) => agent === "codex")
  const antigravity = proposal.covered.filter(({ agent }) => agent === "agy")
  // An Antigravity already running when the grant is made is not reached by it.
  const running = antigravity.filter(({ started }) => started)
  const presets = proposal.presets.length > 0
  const problem =
    presets && repos.length === 0
      ? "Tick a repo under Review for the pushes and pull requests."
      : !presets && commands.length === 0
        ? "Tick something under Review to grant."
        : null
  const answers: { readonly key: Answer; readonly item: MenuItem }[] = [
    {
      key: "until-done",
      item: {
        key: "until-done",
        label: "Allow until they're done",
        effect:
          problem ??
          "Ends when each reports done, or the lead lets them go. Revoke anytime from the Inbox.",
      },
    },
    {
      key: "hour",
      item: { key: "hour", label: "Allow for 1 hour", effect: problem },
    },
    ...(dismiss
      ? [{ key: "decline" as const, item: { key: "decline", label: "Decline", effect: null } }]
      : []),
    {
      key: "terminal",
      item: { key: "terminal", label: "Go to terminal", effect: null, away: true },
    },
  ]
  const run = (at: number): void => {
    const pick = answers[at]?.key
    if (pick === "terminal") return reveal()
    setPressed(at)
    if (pick === "decline") return dismiss?.(row.id)
    if ((pick !== "until-done" && pick !== "hour") || problem) return
    const lifetime: GrantLifetime = pick
    submit(
      {
        kind: "grant",
        answer: {
          type: "grant",
          presets: proposal.presets,
          commands: commands.toSorted((a, b) => a - b),
          // Repos grant nothing without a preset to use them with.
          repos: presets
            ? repos.filter((url) => proposal.repos.some(({ repo }) => repo.url === url))
            : [],
          withLead,
          lifetime,
        },
      },
      `Granted @${lead}'s team${withLead ? ` and @${lead}` : ""} ${lifetimeWords(lifetime)}.`,
    )
  }
  return (
    <>
      <GrantTop proposal={proposal} lead={lead} withLead={withLead} ticked={repos} />
      {extras.length > 0 && (
        <>
          <p
            className="grant-warn"
            style={{ marginLeft: 16, display: "flex", alignItems: "baseline", gap: 6 }}
          >
            @{lead} {askedFor(extras.length, proposal)} ·{" "}
            <button
              type="button"
              className="button link inbox-link text-control"
              aria-expanded={reviewing}
              aria-controls={review}
              onClick={() => setReviewing(!reviewing)}
            >
              Review
            </button>
          </p>
          {reviewing && (
            <Review
              id={review}
              proposal={proposal}
              commands={commands}
              repos={repos}
              disabled={answering}
              onCommand={(at, on) => setCommands((list) => toggle(list, at, on))}
              onRepo={(url, on) => setRepos((list) => toggle(list, url, on))}
            />
          )}
        </>
      )}
      <div style={{ marginLeft: 16 }}>
        <Disclosure label="Details" openLabel="Hide details">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p className="grant-who">Includes teammates @{lead} adds later.</p>
            {presets && repos.length > 1 && (
              <p className="grant-who">In {repos.map(repoName).join(", ")}.</p>
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span id={me} className="grant-who">
                Include me (@{lead}) too
              </span>
              <Switch
                checked={withLead}
                onChange={setWithLead}
                labelledBy={me}
                disabled={answering}
              />
            </div>
            {codex.length > 0 && (
              <p className="grant-warn" data-grant="codex">
                {handlesOf(codex)} {codex.length === 1 ? "uses" : "use"} Codex: allowed commands run
                outside Codex&apos;s sandbox.
              </p>
            )}
            {running.length > 0 && (
              <p className="grant-warn" data-grant="agy">
                {handlesOf(running)} {running.length === 1 ? "picks" : "pick"} this up the next time
                it starts.
              </p>
            )}
            {proposal.agyOutdated && (
              <p className="grant-warn" data-grant="agy-old">
                Antigravity needs updating to 1.4.10 to use this.
              </p>
            )}
            {antigravity.length > 0 && (
              <AutoRunNote
                where="card"
                line="Antigravity on this PC needs one fix to use this grant"
              />
            )}
          </div>
        </Disclosure>
      </div>
      <Menu
        label="Answers"
        items={answers.map(({ item }) => item)}
        busy={answering}
        pressed={answering ? pressed : null}
        onPress={run}
        handle={handle}
        arrived={arrived}
      />
    </>
  )
}

const Tick = ({
  checked,
  disabled,
  onChange,
  children,
}: {
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (on: boolean) => void
  readonly children: React.ReactNode
}): React.JSX.Element => (
  <label className="grant-tick has-focus-visible">
    <Checkbox checked={checked} disabled={disabled} onChange={onChange} />
    <span>{children}</span>
  </label>
)
