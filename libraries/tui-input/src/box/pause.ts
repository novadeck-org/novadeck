/**
 * Marks, in keys a profile gives, where the next must wait for the program to have taken the ones
 * before it, a few polls: a Backspace that leaves a shell mode is lost on opencode when it arrives
 * in the same read as the Ctrl-U that emptied the box (probed 2026-11-22, 1.19.6, in the e2e sandbox).
 * Its own module, as the box's browser entry may name it but not `keys.ts`, which runs on Node.
 */
export const pause = "\0"
