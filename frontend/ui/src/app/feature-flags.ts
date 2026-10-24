// What the person turned on of the app's unfinished parts, kept in the UI store. Code that
// holds a feature back reads its flag with `useFeatureFlag`.
export type FeatureFlags = {
  // Preferences' Experimental switch: early builds and the Experimental tab. The desktop app
  // remembers it as its update channel, `early`; false where the app offers no choice.
  readonly IS_EXPERIMENTAL: boolean
}

export type FeatureFlag = keyof FeatureFlags

export const noFeatureFlags: FeatureFlags = { IS_EXPERIMENTAL: false }
