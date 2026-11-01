/* oxlint-disable react/no-array-index-key -- Commands have no ids; the lists never reorder. */
import { commandWords, type Grant, type GrantPreset } from "@novadeck/core/grants"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ShieldCheck } from "lucide-react"

import { waitLabel } from "./inbox-text"
import { useInboxContext } from "./InboxProvider"

// The grants that are live, at the top of the Inbox: who holds each, what it allows, where,
// how long is left, the last command it allowed, and a Revoke that ends it at once.

const presetWords: Record<GrantPreset, string> = {
  push: "push branches",
  pr: "open and edit pull requests",
}

export const holderText = (grant: Grant): string =>
  grant.holder.kind === "team"
    ? `@${grant.holder.lead}'s team${grant.holder.withLead ? ` and @${grant.holder.lead}` : ""}`
    : `@${grant.holder.handle}`

// The time left on a grant: "until done" for one that lasts so long, else "1h 12m left" (an
// hour grant is never more) or "under a minute left".
export const leftText = (grant: Grant, now: number): string => {
  if (grant.endsAt === null) return "until done"
  // The Inbox's clock ticks every half minute, so a grant just made can be ahead of it.
  const left = Math.min(grant.endsAt - now, grant.endsAt - grant.madeAt)
  const minutes = Math.ceil(Math.max(0, left) / 60_000)
  if (minutes < 1) return "under a minute left"
  if (minutes < 60) return `${minutes}m left`
  const rest = minutes % 60
  return `${Math.floor(minutes / 60)}h${rest > 0 ? ` ${rest}m` : ""} left`
}

const Entry = ({ grant, now }: { readonly grant: Grant; readonly now: number }) => {
  const { revoke, revokeFailures } = useInboxContext()
  const holder = holderText(grant)
  return (
    <li className="grant-row" data-grant-id={grant.id}>
      <div className="grant-row-holder">{holder}</div>
      <div className="grant-row-head">
        <span className="grant-row-left text-caption">{leftText(grant, now)}</span>
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
