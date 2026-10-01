/** A plugin has exactly these two views (rule 9.4). TAs and graders see the professor
 * view; the bridge limits what their role can write, the same as built-in features. */
export type PluginView = 'student' | 'professor'

interface Capability {
  /** Shown to the professor on the plugin card before they approve it (rule 8.2). */
  label: string
  /** Which views may ask for it. Class-wide data never reaches a student's frame (rules 4.1, 4.5). */
  views: PluginView[]
  /** Calls a model. A manifest v2 that declares one must say what happens with AI off
   * (rule 6.2). No V1 capability does. */
  usesAi?: true
}

/** Everything a plugin can ask the bridge to do. Each view declares the ones it uses in
 * the manifest (rule 1.5). Argument schemas and handlers arrive with the bridge. */
const REGISTRY = {
  'context.get': { label: 'See this course’s name and whether the person using it is a student or staff', views: ['student', 'professor'] },
  'course.skills': { label: 'Read this course’s skill list', views: ['student', 'professor'] },
  'course.weakSpots': { label: 'See which skills the class is struggling with', views: ['professor'] },
  'ui.resize': { label: 'Fit itself to the page', views: ['student', 'professor'] },
  'ui.toast': { label: 'Show short notifications', views: ['student', 'professor'] },
} satisfies Record<string, Capability>

export type CapabilityName = keyof typeof REGISTRY

export const CAPABILITIES: Record<CapabilityName, Capability> = REGISTRY

export const CAPABILITY_NAMES = Object.keys(REGISTRY) as [CapabilityName, ...CapabilityName[]]
