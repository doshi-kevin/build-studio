/**
 * Example images for the inspector's Image Gallery.
 *
 * These are bundled, same-origin SVGs under /public/studio-samples — no external API, no
 * Google Images fetch, no network call. They give the gallery a populated, intuitive starting
 * point: clicking one inserts a normal markdown image cell the professor can keep, swap, or
 * edit. Replace `src` with an uploaded/generated image URL once that pipeline exists.
 */
export interface SampleImage {
  id: string
  label: string
  alt: string
  /** Same-origin path under /public. Rendered via a plain <img>, so no script can execute. */
  src: string
}

export const SAMPLE_IMAGES: SampleImage[] = [
  { id: 'line-chart', label: 'Line chart', alt: 'Line chart', src: '/studio-samples/line-chart.svg' },
  { id: 'bar-chart', label: 'Bar chart', alt: 'Bar chart', src: '/studio-samples/bar-chart.svg' },
  { id: 'scatter-plot', label: 'Scatter plot', alt: 'Scatter plot', src: '/studio-samples/scatter-plot.svg' },
  { id: 'histogram', label: 'Histogram', alt: 'Histogram', src: '/studio-samples/histogram.svg' },
  { id: 'neural-network', label: 'Neural network', alt: 'Neural network diagram', src: '/studio-samples/neural-network.svg' },
  { id: 'flowchart', label: 'Flowchart', alt: 'Flowchart', src: '/studio-samples/flowchart.svg' },
]
