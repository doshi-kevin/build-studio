// Renders a live session's name, falling back to a standard "Class — <date>"
// (e.g. "Class — June 30, 2026") when the professor didn't name it — used
// everywhere a session is identified (hub cards, dashboards, in-room headers,
// reports) so the fallback is consistent. Date is formatted in the viewer's
// timezone via LocalDateTime.

import { LocalDateTime } from '@/components/shared/LocalDateTime'

interface Props {
  name: string | null
  createdAt: string
}

export function LiveClassName({ name, createdAt }: Props) {
  const trimmed = name?.trim()
  if (trimmed) return <>{trimmed}</>
  return (
    <>
      Class — <LocalDateTime iso={createdAt} mode="longdate" />
    </>
  )
}
