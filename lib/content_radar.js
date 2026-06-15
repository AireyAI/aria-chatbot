// content_radar.js
//
// Content-gap radar — the moat. Aria logs every question she COULDN'T answer
// (data/channel_gaps.jsonl). This module clusters those misses into themes so
// the owner sees "17 people asked about emergency callouts and your site
// doesn't mention it" — turning support failures into a content roadmap.
//
// DETERMINISTIC ONLY (CLAUDE.md Rule #5): clustering is token-jaccard merging,
// no embeddings, no model call. The AI "draft the actual section copy" step is
// a separate, later concern — this layer just finds and ranks the gaps so the
// work is £0 at runtime and trivially testable. Pure functions: plain data in,
// plain data out, `now` injectable so tests can pin time.
//
// clusterGaps() mirrors the clustering already in server.js's
// /api/dashboard/channel-gaps handler (tokenise = lowercased words > 3 chars,
// jaccard >= 0.4 = same cluster, sort by count desc) so the dashboard and this
// radar agree on what "the same question" means.

const DAY_MS = 24 * 60 * 60 * 1000;

// Lowercase, split on non-alphanumerics, keep tokens longer than 3 chars.
// Identical to the channel-gaps handler so clustering behaviour matches.
function tokenise(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 3)
  );
}

// Jaccard similarity of two token Sets: |intersection| / |union|, in [0,1].
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// Epoch ms of a row's timestamp, or NaN if unparseable.
function tsMs(row) {
  return new Date(row && row.ts).getTime();
}

/**
 * Cluster unanswered-question rows into ranked themes via token-jaccard merging.
 *
 * @param {Array<{ts:string, question:string, ...}>} gapRows  rows from channel_gaps.jsonl
 * @param {object} opts
 * @param {number} [opts.minCount=2]    drop clusters seen fewer than this many times
 * @param {number} [opts.now=Date.now()] current time (epoch ms) — injectable for tests
 * @param {number} [opts.windowDays=30] only consider rows newer than this many days
 * @returns {Array<{theme:string, count:number, examples:string[], lastSeen:string}>}
 *          ranked count desc (tie-break: most recent lastSeen first)
 */
export function clusterGaps(gapRows = [], { minCount = 2, now = Date.now(), windowDays = 30 } = {}) {
  const cutoff = now - windowDays * DAY_MS;

  // Keep only in-window rows that actually carry a question.
  const rows = (Array.isArray(gapRows) ? gapRows : []).filter(r => {
    if (!r || !String(r.question || '').trim()) return false;
    const t = tsMs(r);
    // Unparseable timestamps are excluded — a gap with no time can't be windowed.
    if (!Number.isFinite(t)) return false;
    return t >= cutoff;
  });

  const clusters = [];
  for (const row of rows) {
    const tks = tokenise(row.question);
    let matched = null;
    for (const c of clusters) {
      if (jaccard(c.tokens, tks) >= 0.4) { matched = c; break; }
    }
    const rowMs = tsMs(row);
    if (matched) {
      matched.members.push({ question: String(row.question).trim(), ms: rowMs, ts: row.ts });
      matched.count++;
      for (const t of tks) matched.tokens.add(t);
    } else {
      clusters.push({
        tokens: tks,
        members: [{ question: String(row.question).trim(), ms: rowMs, ts: row.ts }],
        count: 1,
      });
    }
  }

  const out = [];
  for (const c of clusters) {
    if (c.count < minCount) continue;
    // theme = most representative question: the one whose tokens overlap the
    // most other members (the "centroid" phrasing). Ties → most recent.
    const ranked = [...c.members].sort((a, b) => b.ms - a.ms);
    let best = ranked[0];
    let bestScore = -1;
    for (const m of c.members) {
      const mtk = tokenise(m.question);
      let score = 0;
      for (const other of c.members) {
        if (other === m) continue;
        score += jaccard(mtk, tokenise(other.question));
      }
      // Prefer higher overlap; on a tie prefer the more recent phrasing.
      if (score > bestScore || (score === bestScore && m.ms > best.ms)) {
        bestScore = score;
        best = m;
      }
    }
    const lastSeenMs = c.members.reduce((mx, m) => (m.ms > mx ? m.ms : mx), -Infinity);
    const lastSeen = c.members.find(m => m.ms === lastSeenMs)?.ts || null;
    // De-duplicate example questions, most recent first, cap at 5.
    const seen = new Set();
    const examples = [...c.members]
      .sort((a, b) => b.ms - a.ms)
      .map(m => m.question)
      .filter(q => { const k = q.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 5);

    out.push({ theme: best.question, count: c.count, examples, lastSeen });
  }

  // Rank by count desc, then most-recent lastSeen first.
  out.sort((a, b) => b.count - a.count || new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
  return out;
}

/**
 * Of the ranked clusters, surface the ones worth adding to the site: frequent
 * enough AND not already covered by existing site/knowledge topics.
 *
 * "Already covered" = the cluster's theme shares any significant token with an
 * existing topic (token overlap), e.g. an "emergency callout" topic covers an
 * "emergency callouts at night" cluster.
 *
 * @param {Array<{theme:string,count:number,examples:string[],lastSeen:string}>} clusters
 *        output of clusterGaps()
 * @param {object} opts
 * @param {string[]} [opts.existingTopics=[]] topics the site/KB already covers
 * @param {number}   [opts.minCount=3]        a gap must be this frequent to suggest
 * @returns {Array<{theme:string,count:number,examples:string[],lastSeen:string,rationale:string}>}
 */
export function suggestSiteSections(clusters = [], { existingTopics = [], minCount = 3 } = {}) {
  // Union of all significant tokens across the existing topics.
  const coveredTokens = new Set();
  for (const topic of Array.isArray(existingTopics) ? existingTopics : []) {
    for (const t of tokenise(topic)) coveredTokens.add(t);
  }

  const out = [];
  for (const cl of Array.isArray(clusters) ? clusters : []) {
    if (!cl || cl.count < minCount) continue;
    const themeTokens = tokenise(cl.theme);
    // Covered if ANY theme token already appears in an existing topic.
    let covered = false;
    for (const t of themeTokens) {
      if (coveredTokens.has(t)) { covered = true; break; }
    }
    if (covered) continue;

    out.push({
      ...cl,
      rationale: `${cl.count} ${cl.count === 1 ? 'person' : 'people'} asked about this and your site doesn't cover it yet.`,
    });
  }
  return out;
}
