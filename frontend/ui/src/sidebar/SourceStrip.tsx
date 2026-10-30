import { toggleAgent, toggleSquad, type StripSlot } from "./source-agents"

// An agent's chip in the strip: a toggle for keeping its work lit. A squad's lead stands for
// the whole squad, so pointing at it lights them all and a click keeps or releases them all.
const AgentChip = ({
  handle,
  pressed,
  kept,
  tinted,
  following,
  hint,
  onToggle,
  onLight,
}: {
  handle: string
  // What a click would undo: for a lead, the squad's state ("mixed" while only some are kept).
  pressed: boolean | "mixed"
  // Whether this agent itself is kept.
  kept: boolean
  // Whether the chip wears the kept tint itself, rather than the squad's track having it.
  tinted: boolean
  // Nothing is kept and the selected terminal is this agent's.
  following: boolean
  // What a click does, said on hover: a lead's names its squad, as nothing else marks a lead.
  hint: string
  onToggle: () => void
  onLight: (lit: boolean) => void
}): React.JSX.Element => (
  <button
    type="button"
    className="source-agent text-caption"
    title={hint}
    aria-pressed={pressed}
    data-kept={kept && tinted}
    data-following={following}
    onClick={onToggle}
    onPointerEnter={() => onLight(true)}
    onPointerLeave={() => onLight(false)}
  >
    @{handle}
  </button>
)

// The agents with work here as chips above the tree, wrapping onto more lines, squads in a
// faint track with their lead first. A chip keeps its agent lit (any number), a squad's lead the
// whole squad; the tree dims what none of the lit agents touched.
export const SourceStrip = ({
  slots,
  kept,
  selected,
  onKeep,
  onLight,
  onKeyDown,
}: {
  slots: readonly StripSlot[]
  kept: ReadonlySet<string>
  // The selected terminal's agent while nothing is kept and it has work here.
  selected: string | undefined
  onKeep: (next: ReadonlySet<string>) => void
  onLight: (handle: string | undefined) => void
  onKeyDown: (event: React.KeyboardEvent) => void
}): React.JSX.Element => (
  <div
    role="group"
    aria-label="Light agents"
    className="source-strip mt-2.5"
    // Its keys are its own (see interaction/dom.ts): a click here keeps focus here, so Escape
    // releases the kept agents rather than going to the terminal.
    data-own-keys
    onKeyDown={onKeyDown}
    onPointerLeave={() => onLight(undefined)}
  >
    {slots.map((slot) => {
      if (slot.kind === "solo")
        return (
          <AgentChip
            key={slot.handle}
            handle={slot.handle}
            pressed={kept.has(slot.handle)}
            kept={kept.has(slot.handle)}
            tinted
            following={kept.size === 0 && selected === slot.handle}
            hint={kept.has(slot.handle) ? `Let @${slot.handle} go` : `Keep @${slot.handle} lit`}
            onToggle={() => onKeep(toggleAgent(kept, slot.handle))}
            onLight={(on) => onLight(on ? slot.handle : undefined)}
          />
        )
      const whole = slot.members.every((handle) => kept.has(handle))
      const some = slot.members.some((handle) => kept.has(handle))
      return (
        <div
          key={slot.members[0]}
          role="group"
          aria-label={`@${slot.members[0]}'s squad`}
          className="source-squad"
          data-kept={whole}
        >
          {slot.members.map((handle, index) => (
            <AgentChip
              key={handle}
              handle={handle}
              pressed={index === 0 ? (whole ? true : some ? "mixed" : false) : kept.has(handle)}
              kept={kept.has(handle)}
              tinted={!whole}
              following={kept.size === 0 && selected === handle}
              hint={
                index === 0
                  ? whole
                    ? `Let @${handle}'s squad go`
                    : `Keep @${handle}'s squad lit`
                  : kept.has(handle)
                    ? `Let @${handle} go`
                    : `Keep @${handle} lit`
              }
              onToggle={() =>
                onKeep(index === 0 ? toggleSquad(kept, slot.members) : toggleAgent(kept, handle))
              }
              onLight={(on) => onLight(on ? handle : undefined)}
            />
          ))}
        </div>
      )
    })}
  </div>
)
