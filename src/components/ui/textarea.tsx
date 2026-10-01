import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        /* max-h + overflow bound `field-sizing-content`: without a cap the box grows to fit
           whatever is typed, so a long-but-valid value inflates the whole dialog past the
           viewport and pushes its actions out of reach. field-sizing honours max-height, but
           only scrolls if overflow is set — otherwise the text is silently clipped instead. */
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive flex field-sizing-content max-h-[40vh] min-h-16 w-full overflow-y-auto rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
