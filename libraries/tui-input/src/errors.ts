/**
 * Why a prompt was not given. All but `not-switched`, `not-shown` and `unexpanded` write
 * nothing; those three leave what landed of the text as a draft.
 * - `refused`: the caller's `refuse` rule judged the text, and said why in the message;
 * - `gone`: the terminal ended, or the hold on the user's input lapsed, while it waited;
 * - `no-paste`: the screen takes no bracketed paste;
 * - `no-box`: the program's input box is not on its screen;
 * - `shell-mode`: the box is in its shell mode already, where a message would run;
 * - `draft`: the box holds text already, which the prompt would merge into;
 * - `too-tall`: the text shows whole in a box with no room for it on this screen;
 * - `ringing`: a delivery to the terminal outlasted the wait for it;
 * - `unrunnable`: a shell command that its shell mode can't run as written;
 * - `not-switched`: the box did not switch to its shell mode at a typed `!`;
 * - `not-shown`: the paste never showed in the box as exactly the text;
 * - `unexpanded`: the box showed a shell command only as a placeholder its shell would run
 *   as text.
 */
export type PromptRefusalReason =
  | "refused"
  | "gone"
  | "no-paste"
  | "no-box"
  | "shell-mode"
  | "draft"
  | "too-tall"
  | "ringing"
  | "unrunnable"
  | "not-switched"
  | "not-shown"
  | "unexpanded"

/** A prompt that was not given, with why. What the host's `admit` throws passes as it is. */
export class PromptRefusal extends Error {
  constructor(
    readonly reason: PromptRefusalReason,
    message: string,
  ) {
    super(message)
    this.name = "PromptRefusal"
  }
}

/**
 * An interrupt stopped the turn but left text in the box that clearing would lose or could
 * not clear: the user's to clear.
 */
export class BoxNotCleared extends Error {
  constructor() {
    super("The turn is stopped, but the box holds text that was not cleared.")
    this.name = "BoxNotCleared"
  }
}
