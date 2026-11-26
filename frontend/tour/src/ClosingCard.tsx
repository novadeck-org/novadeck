import "./print.css"
import { closingLine } from "./steps"

/**
 * Where the tour ends: the game it built is the person's now, and the project was kept as the
 * story ended, whatever they do here. Its last line in the tour's caption box, Keep building the
 * one button filled (back to the agent's terminal and the live game), Open your own project
 * beside it, and, quieter, removing the Tour project. If keeping the project failed it says so,
 * with another try. Like the stage, it takes no focus and covers nothing but itself, and it sits
 * under the app's dialogs, so one opened later is on top. Closing it changes nothing.
 */
export const TourClosingCard = ({
  canRemove,
  keepError,
  onRetryKeep,
  onKeep,
  onOpen,
  onRemove,
  onClose,
}: {
  // Whether the Tour project is still there to remove.
  readonly canRemove: boolean
  // Why the backend refused to keep the project, where it did.
  readonly keepError: string | null
  readonly onRetryKeep: () => void
  // Goes back to the lead's terminal, in Focus beside its game.
  readonly onKeep: () => void
  // Absent where the backend opens no folder picker, as in a browser, which opens no folder
  // anywhere: the card then offers none.
  readonly onOpen?: (() => void) | undefined
  readonly onRemove: () => void
  readonly onClose: () => void
}): React.JSX.Element => (
  <>
    <div aria-hidden="true" className="tour-print tour-dim" />
    <section aria-label="Tour finished" className="tour-print tour-closing">
      <div className="tour-caption-panel">
        <h3 className="tour-caption-line tour-closing-line">{closingLine}</h3>
      </div>
      <p className="tour-caption-note">
        The team's game is committed in this project, and the next tour starts a fresh one. The
        tour's agents stay on its free model until it runs out, up to 3 hours. For more work, open
        your own agent in this project.
      </p>
      {keepError !== null && (
        <p role="alert" className="tour-caption-note">
          Novadeck couldn't keep the project: {keepError}{" "}
          <button type="button" className="tour-quiet" onClick={onRetryKeep}>
            Try again
          </button>
        </p>
      )}
      <div className="tour-closing-buttons">
        <button type="button" className="tour-button" onClick={onClose}>
          Close
        </button>
        {onOpen && (
          <button type="button" className="tour-button" onClick={onOpen}>
            Open your own project
          </button>
        )}
        <button type="button" className="tour-button tour-button-go" onClick={onKeep}>
          Keep building
        </button>
      </div>
      {canRemove && (
        <button type="button" className="tour-quiet" onClick={onRemove}>
          Remove the Tour project
        </button>
      )}
    </section>
  </>
)
