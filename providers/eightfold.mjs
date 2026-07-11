// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Eightfold AI provider — the Talent Intelligence career sites that many large
// employers run (Netflix's explore.jobs.netflix.net, Bayer, Chevron, and the
// generic <company>.eightfold.ai boards). All are served by the same backend,
// which exposes a public, no-auth JSON list endpoint:
//
//   GET {origin}/api/apply/v2/jobs?domain={domain}&start={n}&num=10&sort_by=relevance
//   → { positions: [{ id, name, location, locations[], canonicalPositionUrl,
//        job_description, department, … }], count }
//
// Zero Claude tokens — pure HTTP + JSON.
//
// PAGINATION: the API hard-caps a page at 10 regardless of the `num` value, so we
// never assume `num` is honoured — each request advances a plain `start` offset
// by the number of positions actually returned, dedups by id, and stops on the
// first short page (or once `count` is covered). A per-id Set also guards against
// a server that ignores the offset and re-serves page 0.
//
// The `domain` query param is REQUIRED by the API and is the tenant key (Netflix
// → "netflix.com", which is NOT its host explore.jobs.netflix.net). Resolution
// precedence: explicit `eightfold.domain` → a `?domain=` param on api:/careers_url
// → the origin host's last two labels (best-effort). Prefer the explicit field.
//
// DETECTION: literal Eightfold hosts (*.eightfold.ai) and any /api/apply/v2/jobs
// URL auto-detect. Branded hosts carry no "eightfold" marker, so those (Netflix)
// must set `provider: eightfold` explicitly in portals.yml (which bypasses
// detect()) alongside `eightfold.domain`.
//
// The list payload ships job_description but it is typically empty (Netflix sends
// ""), so `description` is set only when non-empty; empty descriptions are
// omitted and the scanner's content_filter then passes such jobs, by design.

const PAGE_SIZE = 10;   // Eightfold caps the list API at 10 regardless of num=
const MAX_PAGES = 200;  // safety cap on request count (200 * 10 = 2000 postings)
const MAX_JOBS = 1000;  // cap total postings pulled per site

/**
 * Resolve {origin, domain} from a portals entry, or null when the URL is
 * missing/unparseable/non-http.
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {{origin: string, domain: string}|null}
 */
export function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  let domain = '';
  const explicit = entry.eightfold && typeof entry.eightfold === 'object' ? entry.eightfold.domain : undefined;
  if (typeof explicit === 'string' && explicit.trim()) {
    domain = explicit.trim();
  } else {
    // A `?domain=` param on api: (parsed above) or on careers_url, if distinct.
    let fromQuery = u.searchParams.get('domain');
    if (!fromQuery && entry.careers_url && entry.careers_url !== raw) {
      try {
        fromQuery = new URL(entry.careers_url).searchParams.get('domain');
      } catch {
        /* ignore — careers_url may be unparseable; fall through */
      }
    }
    domain = (fromQuery || '').trim();
  }
  if (!domain) {
    // Best-effort: the registrable domain is usually the host's last two labels.
    const labels = u.hostname.split('.').filter(Boolean);
    domain = labels.length >= 2 ? labels.slice(-2).join('.') : u.hostname;
  }
  return { origin: u.origin, domain };
}

/**
 * Build the jobs list URL for a given offset.
 * @param {string} origin
 * @param {string} domain
 * @param {number} start
 * @param {number} [num]
 */
export function buildJobsUrl(origin, domain, start, num = PAGE_SIZE) {
  const params = new URLSearchParams({
    domain,
    start: String(start),
    num: String(num),
    sort_by: 'relevance',
  });
  return `${origin}/api/apply/v2/jobs?${params.toString()}`;
}

/**
 * Map one jobs-API response to raw {id, title, url, location, description?}.
 * Throws when `positions[]` is absent so endpoint drift surfaces loudly instead
 * of silently yielding zero jobs.
 * @param {any} json
 * @param {{origin: string}} cfg
 */
export function parsePositions(json, cfg) {
  const list = Array.isArray(json?.positions) ? json.positions : null;
  if (!list) throw new Error('eightfold: response missing positions[] array');
  const out = [];
  for (const p of list) {
    const id = p?.id != null && p.id !== '' ? String(p.id) : '';
    const rawTitle = typeof p?.name === 'string' ? p.name
      : typeof p?.posting_name === 'string' ? p.posting_name : '';
    const title = rawTitle.trim();
    if (!id || !title) continue;

    const canonical = typeof p.canonicalPositionUrl === 'string' ? p.canonicalPositionUrl : '';
    const url = /^https?:\/\//i.test(canonical)
      ? canonical
      : `${cfg.origin}/careers/job/${encodeURIComponent(id)}`;

    let location = typeof p.location === 'string' ? p.location.trim() : '';
    if (!location && Array.isArray(p.locations)) {
      location = p.locations.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).join(' / ');
    }

    const row = { id, title, url, location };
    if (typeof p.job_description === 'string' && p.job_description.trim()) {
      row.description = p.job_description;
    }
    out.push(row);
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'eightfold',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    // Auto-claim literal Eightfold-hosted sites and any explicit list-API URL.
    // Branded hosts (e.g. Netflix's explore.jobs.netflix.net) carry no marker
    // and must set `provider: eightfold` in portals.yml.
    if (/\.eightfold\.(ai|com)\b/i.test(url) || /\/api\/apply\/v2\/jobs\b/i.test(url)) {
      return { url };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`eightfold: cannot resolve origin for ${entry.name}`);

    const jobs = [];
    const seen = new Set();
    let total = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * PAGE_SIZE;
      const json = await ctx.fetchJson(buildJobsUrl(cfg.origin, cfg.domain, start), {
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (total === null && Number.isFinite(json?.count)) total = json.count;

      const rawCount = Array.isArray(json?.positions) ? json.positions.length : 0;
      if (rawCount === 0) break;
      const rows = parsePositions(json, cfg);

      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (row.description) job.description = row.description;
        jobs.push(job);
        if (jobs.length >= MAX_JOBS) break;
      }
      if (jobs.length >= MAX_JOBS) break;
      // No new ids this page → server ignored the offset (or we've looped). Stop.
      if (fresh === 0) break;
      // Covered the reported total, or a short page → last page.
      if (total !== null && start + PAGE_SIZE >= total) break;
      if (rawCount < PAGE_SIZE) break;
    }
    return jobs.slice(0, MAX_JOBS);
  },
};
