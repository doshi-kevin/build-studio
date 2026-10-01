'use client'

/**
 * Warehouse context provider — wraps useReducer with auto-save to localStorage.
 */

import { createContext, useContext, useReducer, useEffect, useRef, useMemo } from 'react'
import {
  warehouseReducer,
  initialWarehouseState,
  type WarehouseState,
  type WarehouseAction,
} from './use-warehouse-reducer'
import { warehouseStorage } from '@/lib/warehouse/storage'

// ── Context ─────────────────────────────────────────────────

interface WarehouseContextValue {
  state: WarehouseState
  dispatch: React.Dispatch<WarehouseAction>
}

const WarehouseContext = createContext<WarehouseContextValue | null>(null)

// ── Provider ────────────────────────────────────────────────

interface WarehouseProviderProps {
  children: React.ReactNode
}

export function WarehouseProvider({ children }: WarehouseProviderProps) {
  const [state, dispatch] = useReducer(warehouseReducer, initialWarehouseState)

  // Auto-save to localStorage when isDirty (800ms debounce)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!state.isDirty) return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      warehouseStorage.saveFiles(Object.values(state.files))
      warehouseStorage.saveCourses(Object.values(state.courses))
      warehouseStorage.saveTerms(Object.values(state.terms))
      dispatch({ type: 'MARK_SAVED' })
    }, 800)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [state.isDirty, state.files, state.courses, state.terms])

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch])

  return (
    <WarehouseContext.Provider value={value}>
      {children}
    </WarehouseContext.Provider>
  )
}

// ── Hook ────────────────────────────────────────────────────

export function useWarehouse(): WarehouseContextValue {
  const ctx = useContext(WarehouseContext)
  if (!ctx) {
    throw new Error('useWarehouse must be used within a WarehouseProvider')
  }
  return ctx
}
