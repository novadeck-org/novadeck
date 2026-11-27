/**
 * Why the tour can't do what it was asked, in words for the person: always the contract's
 * `CONFLICT`, which the runner sends its clients as it does its own (`apiError`).
 */
export class TourError extends Error {
  readonly code = "CONFLICT"

  constructor(message: string) {
    super(message)
    this.name = "TourError"
  }
}
