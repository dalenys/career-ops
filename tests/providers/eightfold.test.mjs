// tests/providers/eightfold.test.mjs — Eightfold AI ATS provider.
// Zero-token public JSON list API (/api/apply/v2/jobs). Branded hosts (Netflix's
// explore.jobs.netflix.net) carry no "eightfold" marker and are wired with an
// explicit `provider: eightfold` + `eightfold.domain` in portals.yml.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — eightfold');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/eightfold.mjs')).href);
  const eightfold = mod.default;
  const { resolveConfig, buildJobsUrl, parsePositions } = mod;

  if (eightfold.id === 'eightfold') pass('eightfold.id is "eightfold"');
  else fail(`eightfold.id is ${JSON.stringify(eightfold.id)}`);

  // ── resolveConfig ────────────────────────────────────────────────────
  // Explicit eightfold.domain wins, origin taken from api:
  const c1 = resolveConfig({ name: 'Netflix', api: 'https://explore.jobs.netflix.net', careers_url: 'https://explore.jobs.netflix.net/careers', eightfold: { domain: 'netflix.com' } });
  if (c1 && c1.origin === 'https://explore.jobs.netflix.net' && c1.domain === 'netflix.com') {
    pass('resolveConfig: explicit eightfold.domain wins, origin from api:');
  } else {
    fail(`resolveConfig explicit = ${JSON.stringify(c1)}`);
  }

  // ?domain= query param on careers_url is picked up when no explicit domain
  const c2 = resolveConfig({ name: 'X', careers_url: 'https://explore.jobs.netflix.net/careers?domain=netflix.com&pid=1' });
  if (c2 && c2.domain === 'netflix.com') pass('resolveConfig: reads ?domain= from careers_url');
  else fail(`resolveConfig ?domain= = ${JSON.stringify(c2)}`);

  // Hostname fallback (registrable domain = last two labels) when nothing else given
  const c3 = resolveConfig({ name: 'X', careers_url: 'https://acme.eightfold.ai/careers' });
  if (c3 && c3.domain === 'eightfold.ai') pass('resolveConfig: falls back to last-two-label hostname domain');
  else fail(`resolveConfig hostname fallback = ${JSON.stringify(c3)}`);

  // Unparseable / non-http URL → null
  if (resolveConfig({ name: 'X', careers_url: 'not a url' }) === null) pass('resolveConfig: returns null on unparseable URL');
  else fail('resolveConfig should return null on unparseable URL');
  if (resolveConfig({ name: 'X', careers_url: 'ftp://acme.eightfold.ai' }) === null) pass('resolveConfig: returns null on non-http(s) scheme');
  else fail('resolveConfig should return null on non-http(s) scheme');

  // ── buildJobsUrl ─────────────────────────────────────────────────────
  const built = buildJobsUrl('https://explore.jobs.netflix.net', 'netflix.com', 20);
  const bu = new URL(built);
  if (bu.origin === 'https://explore.jobs.netflix.net'
      && bu.pathname === '/api/apply/v2/jobs'
      && bu.searchParams.get('domain') === 'netflix.com'
      && bu.searchParams.get('start') === '20'
      && bu.searchParams.get('num') === '10') {
    pass('buildJobsUrl: builds /api/apply/v2/jobs with domain/start/num');
  } else {
    fail(`buildJobsUrl = ${built}`);
  }

  // ── parsePositions ───────────────────────────────────────────────────
  const cfg = { origin: 'https://explore.jobs.netflix.net', domain: 'netflix.com' };
  const sample = {
    count: 2,
    positions: [
      { id: 790298014263, name: 'AI Engineer 6', location: 'USA - Remote', locations: ['USA - Remote'], canonicalPositionUrl: 'https://explore.jobs.netflix.net/careers/job/790298014263', job_description: '' },
      { id: 55, name: 'Platform Engineer', location: '', locations: ['Los Gatos, California', 'USA - Remote'], job_description: 'Build the thing.' },
    ],
  };
  const jobs = parsePositions(sample, cfg);
  if (jobs.length === 2) pass('parsePositions: extracts 2 positions');
  else fail(`parsePositions returned ${JSON.stringify(jobs)}`);

  if (jobs[0].url === 'https://explore.jobs.netflix.net/careers/job/790298014263' && jobs[0].location === 'USA - Remote') {
    pass('parsePositions: uses canonicalPositionUrl and location string');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1].location === 'Los Gatos, California / USA - Remote') pass('parsePositions: joins locations[] when location string is empty');
  else fail(`row 1 location = ${JSON.stringify(jobs[1]?.location)}`);

  if (jobs[1].description === 'Build the thing.' && jobs[0].description === undefined) {
    pass('parsePositions: carries non-empty job_description, omits empty ones');
  } else {
    fail(`descriptions = ${JSON.stringify([jobs[0].description, jobs[1].description])}`);
  }

  // Fallback URL when canonicalPositionUrl is missing/non-http
  const fb = parsePositions({ positions: [{ id: 99, name: 'Role', canonicalPositionUrl: 'javascript:void(0)' }] }, cfg);
  if (fb.length === 1 && fb[0].url === 'https://explore.jobs.netflix.net/careers/job/99') {
    pass('parsePositions: builds fallback URL when canonicalPositionUrl is non-http');
  } else {
    fail(`fallback url = ${JSON.stringify(fb)}`);
  }

  // Drops id-less and title-less records
  const dirty = parsePositions({
    positions: [
      { name: 'No id' },
      { id: 1, name: '' },
      { id: 2, name: '   ' },
      { id: 3, name: 'Good' },
    ],
  }, cfg);
  if (dirty.length === 1 && dirty[0].title === 'Good') pass('parsePositions: drops id-less and title-less records');
  else fail(`parsePositions dirty = ${JSON.stringify(dirty)}`);

  // Throws on unexpected shape (endpoint drift surfaces loudly)
  let drifted = false;
  try { parsePositions({ jobs: [] }, cfg); } catch { drifted = true; }
  if (drifted) pass('parsePositions: throws when positions[] is missing');
  else fail('parsePositions should throw on unexpected API response shape');

  // ── detect ───────────────────────────────────────────────────────────
  if (eightfold.detect({ careers_url: 'https://acme.eightfold.ai/careers' })) pass('detect: claims *.eightfold.ai hosts');
  else fail('detect should claim *.eightfold.ai hosts');
  if (eightfold.detect({ api: 'https://jobs.acme.com/api/apply/v2/jobs?domain=acme.com' })) pass('detect: claims /api/apply/v2/jobs URLs');
  else fail('detect should claim /api/apply/v2/jobs URLs');
  if (eightfold.detect({ careers_url: 'https://explore.jobs.netflix.net/careers' }) === null) {
    pass('detect: does NOT auto-claim branded host (needs explicit provider:)');
  } else {
    fail('detect should not auto-claim the branded Netflix host');
  }

  // ── fetch(): paginates by start offset, dedups, stops on short page ───
  let calls = 0;
  const seenStarts = [];
  const mockCtx = {
    fetchJson: async (url, opts) => {
      calls++;
      const u = new URL(url);
      if (u.pathname !== '/api/apply/v2/jobs') throw new Error(`unexpected path ${u.pathname}`);
      if (opts?.redirect !== 'error') throw new Error('expected redirect: error');
      const start = Number(u.searchParams.get('start'));
      seenStarts.push(start);
      // Total 23: pages of 10, 10, 3 → three requests then stop on the short page.
      const total = 23;
      const remaining = Math.max(0, total - start);
      const n = Math.min(10, remaining);
      const positions = Array.from({ length: n }, (_, i) => ({
        id: start + i,
        name: `Role ${start + i}`,
        location: 'USA - Remote',
        canonicalPositionUrl: `https://explore.jobs.netflix.net/careers/job/${start + i}`,
      }));
      return { count: total, positions };
    },
  };
  const fetched = await eightfold.fetch({ name: 'Netflix', api: 'https://explore.jobs.netflix.net', eightfold: { domain: 'netflix.com' } }, mockCtx);
  if (calls === 3 && fetched.length === 23) pass('fetch: paginates by start offset and stops on the short page (3 calls, 23 jobs)');
  else fail(`fetch made ${calls} calls, returned ${fetched.length} jobs (starts: ${seenStarts.join(',')})`);
  if (fetched.every(j => j.company === 'Netflix')) pass('fetch: stamps company on every job');
  else fail('fetch should stamp company on every job');
  if (new Set(fetched.map(j => j.url)).size === fetched.length) pass('fetch: no duplicate URLs');
  else fail('fetch produced duplicate URLs');

} catch (e) {
  fail(`eightfold provider tests crashed: ${e.message}`);
}
