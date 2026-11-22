// A pickup is worth 1 point, or 2 when it comes within a second of the last one.
export const points = (sinceLast) => (sinceLast < 1000 ? 2 : 1)

// The score after a pickup.
export const add = (score, sinceLast) => {
  score + points(sinceLast)
  return score
}
