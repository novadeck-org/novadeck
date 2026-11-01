/* oxlint-disable react/no-array-index-key -- Commands have no ids; the lists never reorder. */
import { commandWords, type Grant, type GrantPreset } from "@novadeck/core/grants"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ShieldCheck } from "lucide-react"

import { waitLabel } from "./inbox-text"
import { useInboxContext, type AtWork } from "./InboxProvider"

// The grants that are live, at the top of the Inbox: who holds each, what it allows, where,
// how long it lasts and who is at work on it, the last command it allowed, and a Revoke that ends it at once.

const presetWords: Record<GrantPreset, string> = {
  push: "push branches",
  pr: "open and edit pull requests",
}

export const holderText = (grant: Grant): string =>
  grant.holder.kind === "team"
    ? `@${grant.holder.lead}'s team${grant.holder.withLead ? ` and @${grant.holder.lead}` : ""}`
    : `@${grant.holder.handle}`

// How long a grant lasts and where it stands, as the list says it: "until done" with the holders
// still at work, or "1 hour" with what is left of it ("42 min left", never more than 60).
export const lifeText = (grant: Grant, now: number, working: readonly string[] = []): string => {
  if (grant.endsAt === null)
    return working.length > 0
      ? `until done · ${working.map((handle) => `@${handle}`).join(", ")} working`
      : "until done"
  // The Inbox's clock ticks every half minute, so a grant just made can be ahead of it.
  const left = Math.min(grant.endsAt - now, grant.endsAt - grant.madeAt, 3_600_000)
  const minutes = Math.ceil(Math.max(0, left) / 60_000)
  return `1 hour · ${minutes < 1 ? "under a minute" : `${minutes} min`} left`
}

// The holders of a grant that are at work now: the lead's teammates (and the lead, where it is
// included) for a team's, the terminal for a terminal's.
const workingHolders = (grant: Grant, atWork: readonly AtWork[]): string[] =>
  atWork
    .filter(({ projectId, handle, ledBy }) =>
      projectId !== grant.projectId
        ? false
        : grant.holder.kind === "team"
          ? ledBy === grant.holder.lead || (grant.holder.withLead && handle === grant.holder.lead)
          : handle === grant.holder.handle,
    )
    .map(({ handle }) => handle)

const Entry = ({ grant, now }: { readonly grant: Grant; readonly now: number }) => {
  const { revoke, revokeFailures, atWork } = useInboxContext()
  const holder = holderText(grant)
  return (
    <li className="grant-row" data-grant-id={grant.id}>
      <div className="grant-row-holder">{holder}</div>
      <div className="grant-row-head">
        <span className="grant-row-left text-caption">
          {lifeText(grant, now, workingHolders(grant, atWork))}
        </span>
        {revoke && (
          <Tooltip content="End this grant now">
            <button
              type="button"
              className="button min-h-6 shrink-0 px-2 text-caption"
              aria-label={`Revoke the grant to ${holder}`}
              onClick={() => revoke(grant.id)}
            >
              Revoke
            </button>
          </Tooltip>
        )}
      </div>
      {revokeFailures[grant.id] !== undefined && (
        <div className="grant-row-error text-caption" role="alert">
          Could not revoke: {revokeFailures[grant.id]}
        </div>
      )}
      <div className="grant-row-what text-caption">
        {grant.presets.map((preset) => presetWords[preset]).join(", ")}
        {grant.presets.length > 0 && grant.repos.length > 0 && (
          <>
            {" in "}
            {grant.repos.map((repo) => repo.url.replace(/^github\.com\//, "")).join(", ")}
          </>
        )}
      </div>
      {grant.commands.length > 0 && (
        <div className="grant-row-commands text-caption">
          {grant.commands.map((command, index) => (
            <code key={index}>
              {commandWords(command).join(" ")}
              {command.rest ? " …" : ""}
            </code>
          ))}
        </div>
      )}
      {grant.lastUse && (
        <div className="grant-row-last text-caption">
          Last allowed: <code>{grant.lastUse.command}</code> by @{grant.lastUse.handle},{" "}
          {waitLabel(grant.lastUse.at, now)} ago
        </div>
      )}
    </li>
  )
}

export const GrantsSection = (): React.JSX.Element | null => {
  const { grants, now } = useInboxContext()
  if (grants.length === 0) return null
  return (
    <section className="inbox-grants" aria-label="Grants">
      <h3 className="inbox-grants-title text-caption">
        <ShieldCheck size={12} strokeWidth={1.8} aria-hidden="true" />
        Grants
      </h3>
      <ul className="inbox-grants-list">
        {grants.map((grant) => (
          <Entry key={grant.id} grant={grant} now={now} />
        ))}
      </ul>
    </section>
  )
}
