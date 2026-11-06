// What cmd would act on, each with a shim reading the line and with the real program getting it.
export const quotedPrompts = [
  "fix a & b | c, 100% done ^ now!",
  'say "hi there" now',
  'he said "hi',
  'a & b "c d" e | f, 100% ^ g!',
  "what does %~ do",
  '50% of "x: y" & z',
]

// What cmd takes to be outside quotes, so the cmd that starts a batch file splits the line there
// before the file runs: no shim can keep these whole, and each must fare as it does without one.
export const splitPrompt = 'say "a & b" now'

// The same at a pipe, where the program doesn't even start, as measured on Windows without a shim.
export const pipedPrompt = 'he said "hi | bye'
