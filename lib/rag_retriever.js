// rag_retriever.js
//
// Lightweight RAG without an embedding API. Strategy:
//   1. Owner uploads a document (plain text or PDF-extracted text)
//   2. We split into ~500 char chunks with ~50 char overlap
//   3. For each incoming customer message, score chunks by token overlap
//      against the message (BM25-lite: TF * IDF-ish)
//   4. Return top 3 chunks for inclusion in Aria's prompt
//
// Why no embeddings: Anthropic doesn't ship them. Adding OpenAI / Voyage
// would mean a second vendor, second API key, second outage source, second
// cost line. Keyword overlap is 80% as good for short customer FAQ-style
// queries which is most of what Aria handles. Swap later if we need more.

const STOPWORDS = new Set('a an and are as at be been but by can could did do does for from had has have he her him his how i if in is it its me my no not of on or our she so than that the their them then there these they this to was we were what when where which who why will with would you your'.split(' '));

export function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9£$€]+/i)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// Split a document into overlapping chunks at sentence boundaries when
// possible, falling back to char-count cuts.
export function chunkDocument(text, { chunkSize = 500, overlap = 50 } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= chunkSize) return [clean];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + chunkSize, clean.length);
    // Try to end at a sentence boundary near the cut
    if (end < clean.length) {
      const lookback = clean.slice(Math.max(i, end - 80), end + 1);
      const sentenceEnd = Math.max(lookback.lastIndexOf('. '), lookback.lastIndexOf('? '), lookback.lastIndexOf('! '));
      if (sentenceEnd > 0) end = end - (lookback.length - sentenceEnd - 2);
    }
    chunks.push(clean.slice(i, end).trim());
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks.filter(c => c.length > 20);
}

// Score one chunk against a query. Higher = more relevant.
// Combines exact-token match (TF-like) with rare-token boost (IDF-ish).
function scoreChunk(chunkTokens, queryTokens, allChunksTokens) {
  let score = 0;
  for (const qt of queryTokens) {
    // Count occurrences in this chunk
    const inChunk = chunkTokens.filter(t => t === qt).length;
    if (!inChunk) continue;
    // Count documents containing this token (for IDF)
    const docFreq = allChunksTokens.filter(ct => ct.includes(qt)).length || 1;
    const idf = Math.log((allChunksTokens.length + 1) / docFreq);
    score += inChunk * idf;
  }
  return score;
}

// Main entry: given query text + a doc list, return top-K chunk strings.
export function retrieveRelevantChunks(query, docs, { topK = 3, minScore = 0.5 } = {}) {
  if (!docs?.length) return [];
  const allChunks = [];
  for (const doc of docs) {
    const chunks = chunkDocument(doc.content || '');
    for (const chunk of chunks) {
      allChunks.push({ title: doc.title || 'Untitled', content: chunk });
    }
  }
  if (!allChunks.length) return [];
  const queryTokens = tokenise(query);
  if (!queryTokens.length) return [];
  const allChunksTokens = allChunks.map(c => tokenise(c.content));
  const scored = allChunks.map((chunk, i) => ({
    chunk, score: scoreChunk(allChunksTokens[i], queryTokens, allChunksTokens),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(s => s.score >= minScore)
    .slice(0, topK)
    .map(s => ({ title: s.chunk.title, content: s.chunk.content, score: Number(s.score.toFixed(2)) }));
}
