import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,opacity] cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * `loading` is the one addition to shadcn's button here.
 *
 * Before it, 145 call sites hand-rolled the same three things — a spinner, a
 * `disabled={isPending}`, and a swapped label — and 231 places hand-placed a
 * `<Loader2 className="animate-spin" />`. They drifted, so a submit button in
 * one corner of the app looked nothing like a submit button in another. This
 * gives them one thing to converge on.
 *
 * It does three things a caller kept forgetting: disables the button (so a
 * second click can't double-submit), marks it `aria-busy` (so a screen reader
 * announces the wait rather than a dead control), and hides the spinner from
 * the accessibility tree (it is decoration; `aria-busy` already carries the
 * meaning).
 *
 * Known trade-off, made deliberately. A native `disabled` moves keyboard focus
 * to the top of the document, which is rude to the person who just pressed the
 * button. The usual remedy is `aria-disabled` plus an onClick guard, keeping the
 * control focusable. It is NOT used here: a disabled submit button is also what
 * blocks IMPLICIT form submission, so a focusable one lets Enter in a text field
 * re-submit a form that is already in flight, and not every form here guards its
 * own handler. Losing focus position beats double-posting an announcement.
 * Revisit once the forms guard themselves.
 *
 * Purely additive — every existing call site behaves exactly as before.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  children,
  onClick,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        buttonVariants({ variant, size, className }),
        /* The visual and pointer half of "busy". Covers the asChild case too,
           where the child may be an anchor that ignores `disabled` entirely. */
        loading && 'pointer-events-none opacity-50',
      )}
      disabled={disabled || (!asChild && loading) || undefined}
      /* asChild only: the child may be an anchor, which ignores `disabled`. */
      aria-disabled={(asChild && loading) || undefined}
      aria-busy={loading || undefined}
      onClick={
        loading
          ? (e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault()
          : onClick
      }
      {...props}
    >
      {/* Under asChild, `children` must stay the SINGLE child: Radix's Slot
          clones one element and throws on an array. Emitting the spinner slot
          conditionally would hand it `[false, children]` even when not loading,
          which breaks every asChild button in the app. So branch on asChild
          rather than on `loading`. */}
      {asChild ? (
        children
      ) : (
        <>
          {loading && <Loader2 className="animate-spin" aria-hidden="true" />}
          {children}
        </>
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
