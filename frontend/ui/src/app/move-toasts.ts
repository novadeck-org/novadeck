import type { MoveBoard } from "../inbox/InboxToasts"
import { movedWords, type MoveNotice } from "../terminals/move-state"
import type { UiStore } from "./ui-store"

// Tells each move the person makes on the board as the backend answers it: where the terminal
// went, still running, with Undo and the way there; or why it couldn't go. A newer move
// replaces the toast of the last. Undo and going there each take the toast away.
export const watchMoveToasts = (
  ui: UiStore,
  board: MoveBoard,
  {
    undoMove,
    goToMoved,
  }: {
    readonly undoMove: (notice: MoveNotice) => void
    readonly goToMoved: (notice: MoveNotice) => void
  },
): (() => void) => {
  let told = ui.getSnapshot().moved
  return ui.subscribe(() => {
    const { moved } = ui.getSnapshot()
    if (moved === told) return
    told = moved
    if (!moved) return board.close()
    board.show({
      id: moved.id,
      words: movedWords(moved),
      failed: moved.failed !== undefined,
      undo: moved.result
        ? () => {
            board.close()
            undoMove(moved)
          }
        : undefined,
      go: () => {
        board.close()
        goToMoved(moved)
      },
    })
  })
}
