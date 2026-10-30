// The sizes a terminal takes, both ends included: the attach contract checks them, and the
// view holds a fitted size to them. Apart from the contract, so the view needs no Zod.
export const sizeBounds = {
  cols: { min: 2, max: 500 },
  rows: { min: 1, max: 200 },
} as const
