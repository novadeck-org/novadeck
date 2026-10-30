/** Checks a limit given as an option, which must be a positive integer. */
export const positive = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
  return value
}
