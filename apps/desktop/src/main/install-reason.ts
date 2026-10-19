// The most characters of an error's own message a reason carries.
export const maxReasonLength = 200

// eslint-disable-next-line no-control-regex -- These are the characters it replaces.
const controls = /[\x00-\x1f\x7f-\x9f]+/gu

/**
 * A reason for the person from the `text` of an error: one line, without control
 * characters, cut to `maxReasonLength` whole characters with an ellipsis. The page puts
 * "Could not install Novadeck:" before it and shortens a long one; cutting here too keeps
 * what crosses the bridge within its limit. Empty text gives an empty reason.
 */
export const reasonText = (text: string): string => {
  const characters = Array.from(text.replace(controls, " ").trim())
  return characters.length <= maxReasonLength
    ? characters.join("")
    : `${characters.slice(0, maxReasonLength - 1).join("")}…`
}
