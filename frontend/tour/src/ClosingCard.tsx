import { harnesses, type AgentName } from "@novadeck/core/harnesses"

const nameOf = (agent: AgentName): string => harnesses.find(({ id }) => id === agent)?.name ?? agent

/**
 * Where the tour ends: it was a sandbox, and the person's own project is next, opened with
 * their agent. It also offers to remove the Tour project, and says that what they open comes
 * back after Novadeck closes. Like the coach, it takes no focus and covers nothing but itself.
 */
export const TourClosingCard = ({
  agent,
  canRemove,
  onOpen,
  onRemove,
  onClose,
}: {
  readonly agent: AgentName
  // Whether the Tour project is still there to remove.
  readonly canRemove: boolean
  // Absent where the backend opens no folder picker, as in a browser, which opens no folder
  // anywhere: the card then offers none.
  readonly onOpen?: (() => void) | undefined
  readonly onRemove: () => void
  readonly onClose: () => void
}): React.JSX.Element => (
  <section
    aria-label="Tour finished"
    className="floating tour-closing flex w-[min(400px,calc(100vw-32px))] flex-col gap-2 p-5"
  >
    <h3 className="m-0 text-heading font-medium">That was the tour</h3>
    <p className="modal-description m-0 text-body leading-[1.55]">
      It ran in a sandbox. Now open your own project, and {nameOf(agent)} starts there with you.
    </p>
    <p className="tour-step m-0 text-caption leading-[1.5]">
      Close Novadeck any time: your terminals and sessions come back.
    </p>
    <div className="mt-2 flex flex-wrap justify-end gap-1.5">
      <button type="button" className="button ghost min-h-8 px-2.5 text-control" onClick={onClose}>
        Close
      </button>
      {canRemove && (
        <button
          type="button"
          className="button ghost min-h-8 px-2.5 text-control"
          onClick={onRemove}
        >
          Remove the Tour project
        </button>
      )}
      {onOpen && (
        <button type="button" className="button primary min-h-8 px-3 text-control" onClick={onOpen}>
          Open your project
        </button>
      )}
    </div>
  </section>
)
