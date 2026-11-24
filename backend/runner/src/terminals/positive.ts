/** A limit's value, or its fallback where none was given; a limit that isn't a positive integer is refused. */
export const positive = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError("Terminal limits must be positive integers.")
  return result
}
