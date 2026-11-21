import { harnesses, type AgentName } from "@novadeck/core/harnesses"

import "./print.css"

const nameOf = (agent: AgentName): string => harnesses.find(({ id }) => id === agent)?.name ?? agent

/**
 * Where the tour ends: it was a sandbox, and the person's own project is next, opened with their
 * agent. Its last line in the tour's caption box, Open your project the one button filled, and,
 * quieter, removing the Tour project. Like the stage, it takes no focus and covers nothing but
 * itself.
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
  <>
    <div aria-hidden="true" className="tour-print tour-dim" />
    <section aria-label="Tour finished" className="tour-print tour-closing">
      <h3 className="tour-caption-line tour-closing-line">
        That's your deck. Now try it on real code.
      </h3>
      <p className="tour-caption-note">
        That was a sandbox. Open your own project and {nameOf(agent)} starts there with you. Close
        Novadeck any time: your terminals and sessions come back.
      </p>
      <div className="tour-closing-buttons">
        <button type="button" className="tour-button" onClick={onClose}>
          Close
        </button>
        {onOpen && (
          <button type="button" className="tour-button tour-button-go" onClick={onOpen}>
            Open your project
          </button>
        )}
      </div>
      {canRemove && (
        <button type="button" className="tour-quiet" onClick={onRemove}>
          Remove the Tour project
        </button>
      )}
    </section>
  </>
)
