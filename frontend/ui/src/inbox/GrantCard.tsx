/* oxlint-disable react/no-array-index-key -- Commands have no ids; the lists never reorder. */
import {
  commandWords,
  defaultGrantHours,
  grantHoursChoices,
  hoursWords,
  presetSentence,
  approvalSentence,
  type GrantCommand,
  type GrantHours,
  type GrantPreset,
  type GrantProposal,
  type GrantRepoChoice,
} from "@novadeck/core/grants"
import type { InboxRow } from "@novadeck/core/inbox"
import { Checkbox } from "@novadeck/toolkit/Checkbox"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import { useState } from "react"

import type { SheetContentProps } from "./ConsoleSheet"
import { useInboxContext } from "./InboxProvider"
import { Menu, type MenuHandle, type MenuItem } from "./Menu"

// The cards that make a grant (#587, #588), in Novadeck's own words: the fixed sentences of
// each preset, the commands as code, who is covered and for how long. Only the person's click
// makes a grant; the agent's own words are quoted, never the card's.

// One granted command as shell-quoted code, `rest` marked in the warning colour.
export const GrantCommandLine = ({
  command,
}: {
  readonly command: GrantCommand
}): React.JSX.Element => (
  <code className="grant-command">
    <span className="console-dollar" aria-hidden="true">
      ${" "}
    </span>
    {commandWords(command).join(" ")}
    {command.rest && (
      <span className="grant-rest" data-mark="rest">
        {" "}
        … followed by anything
      </span>
    )}
  </code>
)

// An approval ask's commands under Novadeck's sentence for them.
export const ApprovalBox = ({
  row,
  commands,
}: {
  readonly row: InboxRow
  readonly commands: readonly GrantCommand[]
}): React.JSX.Element => (
  <div className="console-box grant-box" data-grant="approval">
    <p className="grant-sentence">{approvalSentence(row.source.handle)}</p>
    <ul className="grant-lines" aria-label="Commands">
      {commands.map((command, index) => (
        <li key={index}>
          <GrantCommandLine command={command} />
        </li>
      ))}
    </ul>
    {row.source.agent === "codex" && (
      <p className="grant-warn" data-grant="codex">
        @{row.source.handle} runs Codex, which runs allowed commands outside Codex&apos;s sandbox.
      </p>
    )}
  </div>
)

const fromWords = {
  github: "from GitHub",
  "remote-head": "from the remote's HEAD, which an agent can write",
  guess: "guessed: main and master both held back",
} as const

const flagWords = {
  "added-remote": "added remote",
  recent: "new or changed in the last 24 h",
} as const

const repoName = (url: string): string => url.replace(/^github\.com\//, "")

// A list with an item in it, or out of it.
const toggle = <T,>(list: readonly T[], item: T, on: boolean): T[] =>
  on ? [...list.filter((each) => each !== item), item] : list.filter((each) => each !== item)

// What stayed ticked, and the problem that keeps Grant from going, if there is one.
const problemOf = (
  presets: readonly GrantPreset[],
  commands: readonly number[],
  repos: readonly string[],
): string | null => {
  if (presets.length === 0 && commands.length === 0) return "Tick something to grant."
  if (presets.length > 0 && repos.length === 0)
    return "Tick a repo for the pushes and pull requests."
  return null
}

// A lead's Grant card with the menu that answers it. Everything the lead proposed is ticked
// as proposed, but for the repos it flags; the person unticks what they don't want and picks
// the time, and Grant sends what is left.
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
  const [presets, setPresets] = useState<readonly GrantPreset[]>(proposal.presets)
  const [commands, setCommands] = useState<readonly number[]>(proposal.commands.map((_, at) => at))
  const [repos, setRepos] = useState<readonly string[]>(
    proposal.repos.filter(({ ticked }) => ticked).map(({ repo }) => repo.url),
  )
  const [withLead, setWithLead] = useState(proposal.withLead)
  const [hours, setHours] = useState<GrantHours>(
    grantHoursChoices.includes(proposal.hours) ? proposal.hours : defaultGrantHours,
  )
  const [pressed, setPressed] = useState<number | null>(null)
  const where =
    repos.length === 1
      ? repoName(repos[0]!)
      : repos.length === 0
        ? "no repo yet"
        : "the repos ticked below"
  const problem = problemOf(presets, commands, repos)
  const codex = proposal.covered.filter(({ agent }) => agent === "codex")
  const antigravity = proposal.covered.filter(({ agent }) => agent === "agy")
  const items: MenuItem[] = [
    {
      key: "grant",
      label: "Grant",
      effect: problem ?? `For ${hoursWords(hours)}, as ticked.`,
    },
    ...(dismiss ? [{ key: "decline", label: "Decline", effect: null }] : []),
    { key: "terminal", label: "Go to terminal", effect: null, away: true },
  ]
  const run = (at: number): void => {
    if (items[at]?.away) return reveal()
    setPressed(at)
    if (at === 0) {
      if (problem) return
      const picked = repos.filter((url) => proposal.repos.some(({ repo }) => repo.url === url))
      submit(
        {
          kind: "grant",
          answer: {
            type: "grant",
            presets: proposal.presets.filter((preset) => presets.includes(preset)),
            commands: commands.toSorted((a, b) => a - b),
            repos: picked,
            withLead,
            hours,
          },
        },
        `Granted @${lead}'s team for ${hoursWords(hours)}.`,
      )
    } else dismiss?.(row.id)
  }
  return (
    <>
      <div className="console-box grant-box" data-grant="card">
        {proposal.presets.length > 0 && (
          <fieldset className="grant-group">
            <legend>Allowed</legend>
            {proposal.presets.map((preset) => (
              <Tick
                key={preset}
                checked={presets.includes(preset)}
                disabled={answering}
                onChange={(on) => setPresets((list) => toggle(list, preset, on))}
              >
                {presetSentence(preset, where)}
              </Tick>
            ))}
          </fieldset>
        )}
        {proposal.repos.length > 0 && (
          <fieldset className="grant-group">
            <legend>Repos</legend>
            {proposal.repos.map((choice) => (
              <Tick
                key={choice.repo.url}
                checked={repos.includes(choice.repo.url)}
                disabled={answering}
                onChange={(on) => setRepos((list) => toggle(list, choice.repo.url, on))}
              >
                <RepoLine choice={choice} />
              </Tick>
            ))}
          </fieldset>
        )}
        {proposal.commands.length > 0 && (
          <fieldset className="grant-group">
            <legend>Commands</legend>
            {proposal.commands.map((command, at) => (
              <Tick
                key={at}
                checked={commands.includes(at)}
                disabled={answering}
                onChange={(on) => setCommands((list) => toggle(list, at, on))}
              >
                <GrantCommandLine command={command} />
              </Tick>
            ))}
          </fieldset>
        )}
        <fieldset className="grant-group">
          <legend>Who</legend>
          <p className="grant-who">
            @{lead}&apos;s teammates, now and later (now:{" "}
            {proposal.covered.length > 0
              ? proposal.covered.map(({ handle: each }) => `@${each}`).join(", ")
              : "none"}
            )
          </p>
          <Tick checked={withLead} disabled={answering} onChange={setWithLead}>
            and @{lead} itself
          </Tick>
          {codex.length > 0 && (
            <p className="grant-warn" data-grant="codex">
              {codex.map(({ handle: each }) => `@${each}`).join(", ")}{" "}
              {codex.length === 1 ? "runs" : "run"} Codex, which runs allowed commands outside
              Codex&apos;s sandbox.
            </p>
          )}
          {antigravity.length > 0 && (
            <p className="grant-warn" data-grant="agy">
              {antigravity.map(({ handle: each }) => `@${each}`).join(", ")}{" "}
              {antigravity.length === 1 ? "runs" : "run"} Antigravity, which only partly takes it: a
              teammate started before the grant still asks per command; Antigravity before 1.4.10
              never takes it.
            </p>
          )}
        </fieldset>
        <div className="grant-group grant-time">
          <span className="grant-legend">For</span>
          <SegmentGroup
            label="How long"
            items={grantHoursChoices.map((each) => ({
              value: String(each),
              label: `${each} h`,
            }))}
            value={String(hours)}
            disabled={answering}
            onValueChange={(next) => {
              const chosen = grantHoursChoices.find((each) => String(each) === next)
              if (chosen) setHours(chosen)
            }}
            className="flex shrink-0 gap-1"
            itemClassName="flex h-7 min-w-12 items-center justify-center px-2.5 text-control"
            indicatorClassName="absolute"
          />
        </div>
      </div>
      <Menu
        label="Answers"
        items={items}
        busy={answering}
        pressed={answering ? pressed : null}
        onPress={run}
        handle={handle}
        arrived={arrived}
      />
    </>
  )
}

const RepoLine = ({ choice }: { readonly choice: GrantRepoChoice }): React.JSX.Element => (
  <span className="grant-repo">
    <code>{choice.repo.url}</code>
    {choice.flag && (
      <span className="grant-flag" data-flag={choice.flag}>
        {flagWords[choice.flag]}
      </span>
    )}
    <span className="grant-meta">
      default branch <code>{choice.repo.defaultBranch}</code>, {fromWords[choice.repo.defaultFrom]}
    </span>
  </span>
)

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
