// The core can't import the protocol's wire contracts, so it reads the sounds from its
// data-only entry.
export {
  defaultNoticeSound,
  noticeSoundOf,
  noticeSounds,
  type NoticeSound,
} from "@novadeck/protocol/sounds"
