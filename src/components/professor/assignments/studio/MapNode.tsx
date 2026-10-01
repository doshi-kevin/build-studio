/**
 * MapNode — a TipTap block node that embeds an interactive, fully-customizable map.
 *
 * Sibling of ChartNode: insert it, then "Edit map" to build it up. In edit mode, click anywhere on
 * the map to drop a named marker; rename or remove markers in the list; the current pan/zoom is
 * saved as the map's home view. Config (center, zoom, named markers) is JSON in `data-map`.
 *
 * Uses vanilla Leaflet with OpenStreetMap tiles — no API key, no iframe. Leaflet is imported
 * lazily inside an effect so it never touches `window` during SSR.
 */
'use client'

import 'leaflet/dist/leaflet.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import type { Map as LeafletMap, LayerGroup } from 'leaflet'
import { MapPin, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BlockChrome } from './shared/BlockChrome'
import type { BlockAlign } from './shared/BlockChrome'

export interface MapMarker { lat: number; lng: number; label: string }
export interface MapConfig { center: [number, number]; zoom: number; markers: MapMarker[] }

export const MAP_DEFAULT: MapConfig = { center: [20, 0], zoom: 2, markers: [] }

function parseConfig(raw: string): MapConfig {
  try {
    const c = JSON.parse(raw) as MapConfig
    if (!Array.isArray(c.markers)) c.markers = []
    if (!Array.isArray(c.center) || c.center.length !== 2) c.center = MAP_DEFAULT.center
    return c
  } catch {
    return MAP_DEFAULT
  }
}

function MapNodeView({ node, updateAttributes, deleteNode, getPos, selected, editor }: NodeViewProps) {
  const config = parseConfig(node.attrs.data as string)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<MapConfig>(config)
  const width = (node.attrs.width as number | null) ?? 100
  const align = ((node.attrs.align as string | null) ?? 'center') as BlockAlign

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const layerRef = useRef<LayerGroup | null>(null)
  const leafletRef = useRef<typeof import('leaflet') | null>(null)
  // Refs so the once-bound Leaflet event handlers always read the latest state.
  const editingRef = useRef(false)
  const draftRef = useRef<MapConfig>(config)
  useEffect(() => { editingRef.current = editing }, [editing])
  useEffect(() => { draftRef.current = draft }, [draft])

  // Redraw all markers from a config onto the shared layer group.
  const renderMarkers = useCallback((cfg: MapConfig) => {
    const L = leafletRef.current
    const layer = layerRef.current
    if (!L || !layer) return
    layer.clearLayers()
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#4b56d2'
    cfg.markers.forEach((m) => {
      L.circleMarker([m.lat, m.lng], { radius: 7, color: accent, fillColor: accent, fillOpacity: 0.85, weight: 2 })
        .bindTooltip(m.label || 'Untitled', { permanent: true, direction: 'top', offset: [0, -6] })
        .addTo(layer)
    })
  }, [])

  // Mount the map once.
  useEffect(() => {
    let cancelled = false
    let map: LeafletMap | null = null
    void (async () => {
      const mod = await import('leaflet')
      const L = (mod.default ?? mod) as typeof import('leaflet')
      if (cancelled || !containerRef.current || mapRef.current) return
      leafletRef.current = L
      const initial = parseConfig(node.attrs.data as string)
      // Scroll wheel zooms while the pointer is over the map (Leaflet only captures the wheel when
      // the map is hovered, so page scroll elsewhere is unaffected).
      map = L.map(containerRef.current, { scrollWheelZoom: true, attributionControl: true }).setView(initial.center, initial.zoom)
      mapRef.current = map
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map)
      layerRef.current = L.layerGroup().addTo(map)

      // Click drops a marker while editing.
      map.on('click', (e) => {
        if (!editingRef.current) return
        const { lat, lng } = e.latlng
        const next: MapConfig = {
          ...draftRef.current,
          markers: [...draftRef.current.markers, { lat: +lat.toFixed(5), lng: +lng.toFixed(5), label: `Point ${draftRef.current.markers.length + 1}` }],
        }
        draftRef.current = next
        setDraft(next)
      })
      // Persist the pan/zoom as the home view while editing.
      map.on('moveend', () => {
        if (!editingRef.current || !map) return
        const c = map.getCenter()
        setDraft((p) => ({ ...p, center: [+c.lat.toFixed(5), +c.lng.toFixed(5)], zoom: map!.getZoom() }))
      })

      setTimeout(() => map?.invalidateSize(), 60)
      renderMarkers(initial)
    })()
    return () => {
      cancelled = true
      map?.remove()
      mapRef.current = null
      layerRef.current = null
    }
    // Mount once; later updates flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // In view mode, reflect saved config (markers + home view) when it changes.
  useEffect(() => {
    if (editing || !mapRef.current) return
    mapRef.current.setView(config.center, config.zoom)
    renderMarkers(config)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.attrs.data, editing])

  // While editing, keep markers in sync with the draft.
  useEffect(() => {
    if (editing) renderMarkers(draft)
  }, [draft, editing, renderMarkers])

  const startEdit = useCallback(() => {
    const c = parseConfig(node.attrs.data as string)
    setDraft(c)
    draftRef.current = c
    setEditing(true)
  }, [node.attrs.data])

  const commit = useCallback(() => {
    updateAttributes({ data: JSON.stringify(draft) })
    setEditing(false)
  }, [draft, updateAttributes])

  function addAtCenter() {
    const map = mapRef.current
    if (!map) return
    const c = map.getCenter()
    setDraft((p) => ({ ...p, markers: [...p.markers, { lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), label: `Point ${p.markers.length + 1}` }] }))
  }

  const handleDuplicate = useCallback(() => {
    if (typeof getPos !== 'function') return
    editor.chain().insertContentAt(getPos() + node.nodeSize, node.toJSON()).run()
  }, [editor, getPos, node])

  const shown = editing ? draft : config

  return (
    <NodeViewWrapper>
      <BlockChrome
        editor={editor}
        selected={selected}
        onEdit={startEdit}
        onDelete={deleteNode}
        onDuplicate={handleDuplicate}
        editLabel="Edit map"
        align={align}
        onAlign={(a) => updateAttributes({ align: a })}
        width={width}
        onResize={(pct) => updateAttributes({ width: pct })}
      >
        <div ref={containerRef} className="h-72 w-full overflow-hidden rounded-xl border border-border" style={{ zIndex: 0 }} />

        {!editing ? (
          <div className="mt-2">
            <span className="text-xs text-muted-foreground">
              {shown.markers.length ? `${shown.markers.length} marker${shown.markers.length > 1 ? 's' : ''}` : 'No markers yet'}
            </span>
          </div>
        ) : (
          <div className="mt-4 space-y-3 border-t border-border px-2 pt-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" /> Click the map to drop a marker, then name it below. Pan/zoom sets the home view.
            </p>

            <div className="space-y-1.5">
              {draft.markers.length === 0 && <p className="text-xs text-muted-foreground/70">No markers yet — click the map to add one.</p>}
              {draft.markers.map((m, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_28px] items-center gap-2">
                  <Input
                    value={m.label}
                    onChange={(e) => setDraft((p) => ({ ...p, markers: p.markers.map((mk, idx) => idx === i ? { ...mk, label: e.target.value } : mk) }))}
                    placeholder="Marker name"
                    className="h-8 text-xs"
                  />
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{m.lat.toFixed(2)}, {m.lng.toFixed(2)}</span>
                  <button
                    type="button"
                    onClick={() => setDraft((p) => ({ ...p, markers: p.markers.filter((_, idx) => idx !== i) }))}
                    className="flex h-8 w-7 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addAtCenter}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> Add marker at center
              </button>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); renderMarkers(config) }}>Cancel</Button>
              <Button type="button" size="sm" onClick={commit}>Save map</Button>
            </div>
          </div>
        )}
      </BlockChrome>
    </NodeViewWrapper>
  )
}

export const MapNode = Node.create({
  name: 'map',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      data: {
        default: JSON.stringify(MAP_DEFAULT),
        parseHTML: (el) => el.getAttribute('data-map') ?? JSON.stringify(MAP_DEFAULT),
        renderHTML: (attrs) => ({ 'data-map': attrs.data as string }),
      },
      width: {
        default: 100,
        parseHTML: (el) => { const v = el.getAttribute('data-width'); return v ? Number(v) : 100 },
        renderHTML: (attrs) => ({ 'data-width': String(attrs.width ?? 100) }),
      },
      align: {
        default: 'center',
        parseHTML: (el) => el.getAttribute('data-align') ?? 'center',
        renderHTML: (attrs) => ({ 'data-align': (attrs.align as string) ?? 'center' }),
      },
    }
  },
  parseHTML() { return [{ tag: 'div[data-map]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-map': '' }, HTMLAttributes)] },
  addNodeView() { return ReactNodeViewRenderer(MapNodeView) },
})
