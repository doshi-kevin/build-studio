/**
 * URL classification for module-item references and videos. Pure, dependency-
 * free regex helpers — safe to use both client-side (EditItemDialog derives
 * badges + stored metadata as the professor types) and server-side (the roadmap
 * adapter picks the right node kind at render). Keep it free of React/browser
 * APIs so the server bundle can import it.
 */

/** Derive a video's provider from its URL — youtube / vimeo / generic link. */
export function detectVideoProvider(url: string): 'youtube' | 'vimeo' | 'link' {
  if (/(?:youtube\.com|youtu\.be)/i.test(url)) return 'youtube'
  if (/vimeo\.com/i.test(url)) return 'vimeo'
  return 'link'
}

// Academic-paper hosts (arXiv, DOIs, conference proceedings, journals, preprints).
const PAPER_URL = /(?:arxiv\.org|doi\.org|aclanthology\.org|aclweb\.org|dl\.acm\.org|ieeexplore\.ieee\.org|link\.springer\.com|sciencedirect\.com|jmlr\.org|papers\.nips\.cc|proceedings\.mlr\.press|openreview\.net|biorxiv\.org|pubmed\.ncbi|semanticscholar\.org|researchgate\.net)/i
// Blogs / long-form reading sites.
const READING_URL = /(?:medium\.com|substack\.com|dev\.to|towardsdatascience\.com|distill\.pub|thegradient\.pub|hackernoon\.com|blogspot\.com|wordpress\.com|\.github\.io)/i

/** Classify a reference URL: academic paper, blog/reading, or plain link. */
export function detectReferenceType(url: string): 'link' | 'paper' | 'reading' {
  if (PAPER_URL.test(url)) return 'paper'
  if (READING_URL.test(url)) return 'reading'
  return 'link'
}

// Friendly venue names for known paper hosts (no clean identifier to extract).
const VENUE_HOSTS: [RegExp, string][] = [
  [/aclanthology\.org|aclweb\.org/i, 'ACL Anthology'],
  [/dl\.acm\.org/i, 'ACM'],
  [/ieeexplore\.ieee\.org/i, 'IEEE'],
  [/link\.springer\.com/i, 'Springer'],
  [/sciencedirect\.com/i, 'ScienceDirect'],
  [/jmlr\.org/i, 'JMLR'],
  [/papers\.nips\.cc/i, 'NeurIPS'],
  [/proceedings\.mlr\.press/i, 'PMLR'],
  [/openreview\.net/i, 'OpenReview'],
  [/biorxiv\.org/i, 'bioRxiv'],
  [/pubmed\.ncbi/i, 'PubMed'],
  [/semanticscholar\.org/i, 'Semantic Scholar'],
  [/researchgate\.net/i, 'ResearchGate'],
]

/** Extract a paper's venue + identifier from its URL (arXiv id / DOI when present). */
export function extractVenue(url: string): { venue: string; venueId?: string } | null {
  const arxiv = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i)
  if (arxiv) return { venue: 'arXiv', venueId: arxiv[1] }
  const doi = url.match(/doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/i)
  if (doi) return { venue: 'DOI', venueId: doi[1] }
  for (const [re, name] of VENUE_HOSTS) if (re.test(url)) return { venue: name }
  return null
}
