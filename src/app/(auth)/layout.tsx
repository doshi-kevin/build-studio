/**
 * Auth Layout — wraps /login, /forgot-password and /reset-password.
 *
 * Exists only to carry the reduced-motion setting. All three pages animate
 * their card entrance and their error enter/exit, and none of them honoured
 * prefers-reduced-motion before this.
 *
 * Deliberately renders nothing of its own: this group has no Toaster and no
 * chrome by design (see .claude/rules/dead-ends.md — a toast fired from here
 * is silently swallowed), and adding markup would change three working pages.
 *
 * Type: Server Component. MotionProvider supplies the client boundary.
 */

import { MotionProvider } from '@/components/shared/MotionProvider'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <MotionProvider>{children}</MotionProvider>
}
