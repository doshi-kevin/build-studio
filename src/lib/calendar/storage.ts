/**
 * Calendar mock persistence layer — localStorage-backed repository.
 *
 * Provides a CalendarRepository interface that can be swapped for Supabase later.
 */

import type {
  OfficeHours,
  Booking,
  BlockedTime,
  Slot,
} from '@/lib/validations/calendar'

// ── Repository Interface ────────────────────────────────────

export interface CalendarRepository {
  // Office Hours
  getOfficeHours(): OfficeHours[]
  saveAllOfficeHours(items: OfficeHours[]): void
  deleteOfficeHours(id: string): void

  // Bookings
  getBookings(): Booking[]
  saveAllBookings(items: Booking[]): void
  deleteBooking(id: string): void

  // Blocked Times
  getBlockedTimes(): BlockedTime[]
  saveAllBlockedTimes(items: BlockedTime[]): void
  deleteBlockedTime(id: string): void

  // Slots
  getSlots(): Slot[]
  saveAllSlots(items: Slot[]): void

  // Bulk check
  hasData(): boolean
}

// ── Storage Keys ────────────────────────────────────────────

const KEYS = {
  officeHours: 'scholera_calendar_office_hours',
  bookings: 'scholera_calendar_bookings',
  blockedTimes: 'scholera_calendar_blocked_times',
  slots: 'scholera_calendar_slots',
} as const

// ── Helpers ─────────────────────────────────────────────────

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage full or unavailable — fail silently
  }
}

// ── LocalStorage Implementation ─────────────────────────────

class LocalStorageCalendarRepository implements CalendarRepository {
  // ── Office Hours ────────────────────────────────────────

  getOfficeHours(): OfficeHours[] {
    return readJSON<OfficeHours[]>(KEYS.officeHours, [])
  }

  saveAllOfficeHours(items: OfficeHours[]): void {
    writeJSON(KEYS.officeHours, items)
  }

  deleteOfficeHours(id: string): void {
    const items = this.getOfficeHours().filter((oh) => oh.id !== id)
    writeJSON(KEYS.officeHours, items)
  }

  // ── Bookings ────────────────────────────────────────────

  getBookings(): Booking[] {
    return readJSON<Booking[]>(KEYS.bookings, [])
  }

  saveAllBookings(items: Booking[]): void {
    writeJSON(KEYS.bookings, items)
  }

  deleteBooking(id: string): void {
    const items = this.getBookings().filter((b) => b.id !== id)
    writeJSON(KEYS.bookings, items)
  }

  // ── Blocked Times ───────────────────────────────────────

  getBlockedTimes(): BlockedTime[] {
    return readJSON<BlockedTime[]>(KEYS.blockedTimes, [])
  }

  saveAllBlockedTimes(items: BlockedTime[]): void {
    writeJSON(KEYS.blockedTimes, items)
  }

  deleteBlockedTime(id: string): void {
    const items = this.getBlockedTimes().filter((bt) => bt.id !== id)
    writeJSON(KEYS.blockedTimes, items)
  }

  // ── Slots ───────────────────────────────────────────────

  getSlots(): Slot[] {
    return readJSON<Slot[]>(KEYS.slots, [])
  }

  saveAllSlots(items: Slot[]): void {
    writeJSON(KEYS.slots, items)
  }

  // ── Bulk ────────────────────────────────────────────────

  hasData(): boolean {
    return this.getOfficeHours().length > 0
  }
}

// ── Singleton Export ─────────────────────────────────────────

export const calendarStorage: CalendarRepository = new LocalStorageCalendarRepository()
