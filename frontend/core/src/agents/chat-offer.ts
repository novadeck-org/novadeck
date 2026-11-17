// Whether the one-time offer of Agent Chat has been answered (turned on, declined, or settled
// by the person choosing the chat view's setting some other way, as the welcome dialog and
// Preferences do). It lives in local storage beside the preferences it is about, under a key
// of its own: it is a note of what was asked, not a setting, and saved preferences from before
// the offer have no such field to carry it. A person whose storage has no note has not been
// asked. Without storage the page's own state keeps it for the session.
const chatOfferAnsweredStorageKey = "novadeck.agent-chat-offer-answered"

export const readChatOfferAnswered = (): boolean => {
  try {
    return localStorage.getItem(chatOfferAnsweredStorageKey) === "true"
  } catch {
    return false
  }
}

export const writeChatOfferAnswered = (answered: boolean): void => {
  try {
    localStorage.setItem(chatOfferAnsweredStorageKey, String(answered))
  } catch {
    /* The offer stays answered for this session when storage is unavailable. */
  }
}
