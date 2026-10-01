// Scholera motion constants — the app-wide motion language.
//
// Promoted from src/lib/live-classroom/motion.ts, where this vocabulary was
// written and proven, and widened to the whole product. The reasoning below is
// the original's, unchanged; only its scope grew.
//
// ─── WHEN TO ANIMATE AT ALL ──────────────────────────────────────────────────
//
// This table governs every motion decision in the app, and it is the rule that
// keeps the product from feeling like a template. Most surfaces correctly get
// NO animation.
//
//   100+ times/day   sidebar nav, tab switch, anything keyboard-triggered
//                    → zero animation, always
//   tens/day         list rows, table rows, directory grids
//                    → reduce hard, or nothing
//   occasional       modals, drawers, toasts, overlays
//                    → standard motion
//   rare / first-run onboarding, empty states, celebrations
//                    → may carry personality
//
// Three independent sources converge on this. Apple's Human Interface
// Guidelines: "generally avoid adding motion to UI interactions that occur
// frequently." Emil Kowalski: never animate keyboard-initiated actions, because
// they are repeated hundreds of times a day. Rauno Freiberg: animating
// high-frequency interactions removes novelty and increases cognitive burden.
//
// The corollary that matters most here: animating something a professor does
// fifty times while grading does not make the app feel richer, it makes it feel
// slower. When in doubt, do not animate.
//
// ─── WHY SPRINGS ─────────────────────────────────────────────────────────────
//
// Everything used to animate with a fixed-duration tween (`duration: 0.18 |
// 0.2 | 0.25 | 0.4` with an ad-hoc cubic-bezier, picked per call site). A tween
// can't be grabbed mid-flight: it runs its scripted curve to the end regardless
// of what the user does next. Springs animate from the CURRENT on-screen value,
// so retargeting or reversing mid-animation is continuous instead of a visible
// jump — which matters because these elements appear and disappear on events
// the user is also interacting with.
//
// Framer Motion's `bounce` + `duration` spring API maps onto Apple's two
// designer-facing parameters: `bounce` is the inverse of damping ratio
// (0 = critically damped, no overshoot) and `duration` is "response", how
// quickly the value reaches the target — NOT a fixed runtime, since a spring's
// settle time emerges from its parameters.
//
// Default to SPRING. Overshoot is only correct when the gesture that triggered
// the motion carried momentum: a card you flicked should overshoot, a menu that
// merely appeared should not.
//
// ─── REDUCED MOTION ──────────────────────────────────────────────────────────
//
// None of these are individually guarded. Roots are wrapped in
// <MotionConfig reducedMotion="user"> instead — the (dashboard) and (auth)
// layouts, plus the three feature roots that had it first. That makes framer
// skip transform and layout animations while keeping opacity ones: the correct
// split, applied once rather than at every call site.

/** Critically damped default — no overshoot. Anything that appears, moves or resizes. */
export const SPRING = { type: 'spring', bounce: 0, duration: 0.35 } as const

/** Same curve, quicker. Small elements (chips, badges, counters) where 0.35s reads as lag. */
export const SPRING_SNAPPY = { type: 'spring', bounce: 0, duration: 0.22 } as const

/**
 * Slight overshoot. Only for motion that carries momentum or has to grab
 * peripheral vision — the next-slide preview tucking into its corner stub, and
 * the reaction badges popping when a count changes. Overshoot on something that
 * merely faded in reads as decoration; here it reads as physical.
 */
export const SPRING_POP = { type: 'spring', bounce: 0.2, duration: 0.35 } as const

/**
 * Slide cross-dissolve. Deliberately a plain opacity tween, not a spring and
 * not a translate: `SlideAnnotationLayer` maps pointer coordinates against its
 * own bounding rect on every stroke, so transforming the stage mid-gesture
 * would corrupt drawings. Opacity leaves geometry untouched.
 */
export const SLIDE_FADE = { duration: 0.14, ease: 'easeOut' } as const

/**
 * Tab switching. Deliberately a fast tween, NOT a spring: a tab crossfade can't
 * be retargeted mid-flight (the tab either changed or it didn't), so
 * interruptibility buys nothing, and this is among the controls users touch
 * most. 0.15s is the "feels instant" value; a 0.22s spring here was a felt
 * slowdown on the highest-frequency interaction in the feature.
 */
export const TAB_FADE = { duration: 0.15 } as const

/* ─── Tween entrances ────────────────────────────────────────────────────────
 *
 * The three below are tweens rather than springs because they describe content
 * ARRIVING, which is a one-way event with no gesture behind it and nothing to
 * retarget mid-flight. The spring tokens above stay the default for anything
 * that moves, resizes, or can be interrupted.
 *
 * They all share one curve. That is the point: before this, the codebase had
 * four competing entrance curves ([0.22,1,0.36,1], [0.16,1,0.3,1],
 * [0.25,0.46,0.45,0.94], [0.21,0.47,0.32,0.98]) with no owner, which is what
 * made the app feel assembled rather than designed. */

/** The canonical curve. Emil Kowalski's strong ease-out, to a rounding error. */
const OUT_QUINT = [0.22, 1, 0.36, 1] as const

/**
 * Content arriving in place: a list item, an inline panel, an error message.
 * These are `animated-list.tsx`'s exact original values, so every one of the 33
 * surfaces already using it is unchanged by adopting this token.
 */
export const ENTER = { duration: 0.2, ease: OUT_QUINT } as const

/**
 * Leaving. Deliberately faster than ENTER: an exit should get out of the way,
 * and matching enter/exit timing reads as sluggish. Material's published pair is
 * 225ms in, 195ms out; same ratio, quicker absolute numbers.
 */
export const EXIT = { duration: 0.16, ease: OUT_QUINT } as const

/**
 * A whole surface arriving for the first time — an auth card, a first-run
 * panel. Slower than ENTER because it is a larger object travelling further,
 * and because it happens once rather than many times a day.
 */
export const SURFACE_ENTER = { duration: 0.5, ease: OUT_QUINT } as const
