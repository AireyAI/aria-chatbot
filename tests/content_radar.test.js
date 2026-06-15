import { describe, it, expect } from 'vitest';
import { clusterGaps, suggestSiteSections } from '../lib/content_radar.js';

// Pinned "now" so windowing is deterministic.
const NOW = Date.parse('2026-06-15T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const gap = (question, n = 1) => ({ ts: daysAgo(n), question, ownerEmail: 'o@x.com', channel: 'web' });

describe('clusterGaps', () => {
  it('merges questions that share enough tokens into one cluster', () => {
    const rows = [
      gap('do you offer emergency callouts'),       // {offer, emergency, callouts}
      gap('emergency callouts offer available'),     // jaccard 0.5 with first
      gap('offer emergency callouts overnight'),      // jaccard 0.5 with first
    ];
    const clusters = clusterGaps(rows, { minCount: 2, now: NOW });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(3);
    // theme is a real member question, not a synthetic string
    expect(rows.map(r => r.question)).toContain(clusters[0].theme);
  });

  it('does NOT merge questions whose token overlap is below 0.4 (mirrors server.js, no stemmer)', () => {
    // "callouts" (plural) vs "callout" (singular) do not stem-merge here — the
    // channel-gaps handler this mirrors uses raw tokens, so they stay apart.
    const rows = [
      gap('do you offer emergency callouts'),  // {offer, emergency, callouts}
      gap('can I book an emergency callout'),    // {book, emergency, callout} → 0.166
    ];
    const clusters = clusterGaps(rows, { minCount: 1, now: NOW });
    expect(clusters).toHaveLength(2);
  });

  it('keeps distinct topics in separate clusters', () => {
    const rows = [
      gap('do you offer emergency callouts'),       // {offer, emergency, callouts}
      gap('emergency callouts offer available'),     // merges with above (0.5)
      gap('weekend parking spaces available nearby'), // parking topic
      gap('parking spaces available nearby weekend'), // merges with parking
    ];
    const clusters = clusterGaps(rows, { minCount: 2, now: NOW });
    expect(clusters).toHaveLength(2);
    const themes = clusters.map(c => c.theme.toLowerCase()).join(' | ');
    expect(themes).toMatch(/emergency/);
    expect(themes).toMatch(/parking/);
  });

  it('ranks clusters by count descending', () => {
    const rows = [
      // payment cluster: 3 members, each high-overlap with the first
      gap('what payment methods cards accepted'),     // {what, payment, methods, cards, accepted}
      gap('payment methods cards accepted here'),       // 0.66 with first
      gap('payment methods cards accepted today'),      // 0.66 with first
      // parking cluster: 2 members
      gap('weekend parking spaces available nearby'),
      gap('parking spaces available nearby weekend'),
    ];
    const clusters = clusterGaps(rows, { minCount: 2, now: NOW });
    expect(clusters.length).toBe(2);
    expect(clusters[0].count).toBe(3);
    expect(clusters[1].count).toBe(2);
    expect(clusters[0].theme.toLowerCase()).toMatch(/payment/);
  });

  it('respects minCount — drops singletons below the threshold', () => {
    const rows = [
      gap('do you offer emergency callouts'),
      gap('emergency callouts offer available'),    // merges → count 2
      gap('a totally unrelated one-off question about goldfish'),
    ];
    const def = clusterGaps(rows, { now: NOW }); // minCount default 2
    expect(def).toHaveLength(1);
    expect(def[0].count).toBe(2);

    // With minCount 1 the singleton survives
    const lenient = clusterGaps(rows, { minCount: 1, now: NOW });
    expect(lenient.length).toBe(2);
  });

  it('windows out rows older than windowDays', () => {
    const rows = [
      gap('do you offer emergency callouts', 1),
      gap('emergency callouts offer available', 2),  // merges with above
      // 40 days ago — outside default 30-day window
      gap('emergency callouts offer available stale', 40),
    ];
    const clusters = clusterGaps(rows, { minCount: 1, now: NOW, windowDays: 30 });
    const total = clusters.reduce((s, c) => s + c.count, 0);
    expect(total).toBe(2); // stale row excluded

    // Widening the window pulls the stale one back in
    const wide = clusterGaps(rows, { minCount: 1, now: NOW, windowDays: 60 });
    expect(wide.reduce((s, c) => s + c.count, 0)).toBe(3);
  });

  it('treats the windowDays boundary inclusively (>= cutoff survives)', () => {
    // Exactly windowDays old → ts === cutoff → kept (>=)
    const onBoundary = { ts: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(), question: 'edge case question about timing' };
    const justOver = { ts: new Date(NOW - 30 * 24 * 60 * 60 * 1000 - 1000).toISOString(), question: 'edge case question about timing' };
    expect(clusterGaps([onBoundary], { minCount: 1, now: NOW, windowDays: 30 })).toHaveLength(1);
    expect(clusterGaps([justOver], { minCount: 1, now: NOW, windowDays: 30 })).toHaveLength(0);
  });

  it('picks the centroid phrasing as theme, not merely the most-recent member', () => {
    // The most-recent member is a loose outlier ("overnight delivery extra")
    // that merges in but overlaps the others least. The theme must be the core
    // phrasing (highest summed jaccard with siblings), NOT the recent outlier —
    // otherwise the radar would surface a misleading representative question.
    const rows = [
      gap('payment methods cards accepted overnight delivery extra', 1), // most recent, loosest overlap
      gap('what payment methods cards accepted', 3),                      // core phrasing
      gap('payment methods cards accepted today', 4),                     // core phrasing
    ];
    const [cluster] = clusterGaps(rows, { minCount: 2, now: NOW });
    expect(cluster.count).toBe(3);
    expect(cluster.theme).toBe('what payment methods cards accepted');
    // guard against a regression to "most recent wins"
    expect(cluster.theme).not.toBe('payment methods cards accepted overnight delivery extra');
  });

  it('breaks count ties by most-recent lastSeen first in the final ranking', () => {
    // Two clusters, both count 2. The one whose latest member is more recent
    // must sort first (the recency tie-break on line `b.count - a.count || ...`).
    const rows = [
      gap('weekend parking spaces available nearby', 10),  // older cluster
      gap('parking spaces available nearby weekend', 11),
      gap('do you offer emergency callouts', 1),            // newer cluster
      gap('emergency callouts offer available', 2),
    ];
    const clusters = clusterGaps(rows, { minCount: 2, now: NOW });
    expect(clusters.map(c => c.count)).toEqual([2, 2]);
    // Equal counts → the cluster with the more recent lastSeen leads.
    expect(clusters[0].theme.toLowerCase()).toMatch(/emergency/);
    expect(clusters[1].theme.toLowerCase()).toMatch(/parking/);
  });

  it('lastSeen is the most-recent timestamp in the cluster', () => {
    const rows = [
      gap('do you offer emergency callouts', 10),
      gap('emergency callouts offer available', 2), // most recent, merges
      gap('offer emergency callouts overnight', 5),  // merges
    ];
    const [cluster] = clusterGaps(rows, { minCount: 2, now: NOW });
    expect(cluster.count).toBe(3);
    expect(cluster.lastSeen).toBe(daysAgo(2));
  });

  it('de-duplicates example questions and caps at 5', () => {
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push(gap('do you offer emergency callouts service', i + 1));
    const [cluster] = clusterGaps(rows, { minCount: 2, now: NOW });
    expect(cluster.count).toBe(8);
    // identical phrasing → one unique example, capped regardless at 5
    expect(cluster.examples.length).toBeLessThanOrEqual(5);
    expect(new Set(cluster.examples.map(e => e.toLowerCase())).size).toBe(cluster.examples.length);
  });

  it('skips rows with empty / missing questions and unparseable timestamps', () => {
    const rows = [
      gap('do you offer emergency callouts'),
      gap('are emergency callouts available'),
      { ts: daysAgo(1), question: '   ' },        // blank
      { ts: daysAgo(1) },                          // no question
      { ts: 'not-a-date', question: 'emergency callouts unparseable time' }, // bad ts
    ];
    const clusters = clusterGaps(rows, { minCount: 2, now: NOW });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
  });

  it('returns [] for empty / non-array input', () => {
    expect(clusterGaps([], { now: NOW })).toEqual([]);
    expect(clusterGaps(undefined, { now: NOW })).toEqual([]);
    expect(clusterGaps(null, { now: NOW })).toEqual([]);
  });
});

describe('suggestSiteSections', () => {
  const clusters = [
    { theme: 'do you offer emergency callouts', count: 6, examples: ['do you offer emergency callouts'], lastSeen: daysAgo(1) },
    { theme: 'what are your opening hours', count: 4, examples: ['what are your opening hours'], lastSeen: daysAgo(2) },
    { theme: 'is there parking nearby', count: 2, examples: ['is there parking nearby'], lastSeen: daysAgo(3) },
  ];

  it('filters out clusters already covered by an existing topic (token overlap)', () => {
    const out = suggestSiteSections(clusters, {
      existingTopics: ['Opening hours and bank holidays'],
      minCount: 3,
    });
    const themes = out.map(c => c.theme);
    expect(themes).toContain('do you offer emergency callouts');
    expect(themes).not.toContain('what are your opening hours'); // covered via "hours"
  });

  it('applies minCount — only frequent gaps are suggested', () => {
    const out = suggestSiteSections(clusters, { existingTopics: [], minCount: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].theme).toBe('do you offer emergency callouts');
  });

  it('attaches a human rationale string with the count', () => {
    const out = suggestSiteSections(clusters, { existingTopics: [], minCount: 3 });
    expect(out[0].rationale).toMatch(/6 people asked/);
    // singular grammar
    const one = suggestSiteSections(
      [{ theme: 'do you take crypto payments now', count: 1, examples: [], lastSeen: daysAgo(1) }],
      { minCount: 1 }
    );
    expect(one[0].rationale).toMatch(/^1 person asked/);
  });

  it('returns everything frequent enough when no existing topics', () => {
    const out = suggestSiteSections(clusters, { existingTopics: [], minCount: 3 });
    expect(out.map(c => c.theme)).toEqual([
      'do you offer emergency callouts',
      'what are your opening hours',
    ]);
  });

  it('handles empty input', () => {
    expect(suggestSiteSections([], {})).toEqual([]);
    expect(suggestSiteSections(undefined, {})).toEqual([]);
  });

  it('preserves cluster fields (count, examples, lastSeen) on the suggestion', () => {
    const out = suggestSiteSections(clusters, { existingTopics: [], minCount: 3 });
    const first = out[0];
    expect(first.count).toBe(6);
    expect(first.examples).toEqual(['do you offer emergency callouts']);
    expect(first.lastSeen).toBe(daysAgo(1));
  });
});
