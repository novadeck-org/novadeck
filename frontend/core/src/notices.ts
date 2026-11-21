// The core can't import the protocol's wire contracts, so it reads how Novadeck's notices are
// taken apart from its data-only entry: one rule for the chat and the terminal overlay.
export {
  noticeBody,
  noticeOneLine,
  noticePrefix,
  noticeSeen,
  readNotice,
  splitHookText,
  type ReadNotice,
} from "@novadeck/protocol/notices"
