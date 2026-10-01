export type ViewMode = 'professor' | 'student' | 'split'

export type Device = 'desktop' | 'phone'

/** A plugin being built. What it does is whatever the professor described. */
export interface StudioBuild {
  id: string
  title: string
  prompt: string
}

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'athena'; text: string }
