// Leaderboard logic, kept separate from Netlify so it can be tested on its own.
// The store only needs two methods (same shape as a Netlify Blobs store):
//   getWithMetadata(key, opts) -> { data, etag } | null
//   setJSON(key, value, { onlyIfMatch | onlyIfNew }) -> { modified }

export const MAX_ENTRIES = 10;
export const MAX_NAME_LENGTH = 4;
export const MAX_SCORE = 99999; // the game shows scores as 5 digits
const KEY = 'top10';
const MAX_ATTEMPTS = 6;

// Names: letters and numbers only, upper-case, at most 4 characters.
export function cleanName(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, MAX_NAME_LENGTH);
}

// Scores: whole numbers from 1 to 99999.
export function cleanScore(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  return whole >= 1 && whole <= MAX_SCORE ? whole : null;
}

// Each submission carries a unique id so the same submission can never be
// added twice (for example if the server has to retry a save).
export function cleanId(raw) {
  const id = String(raw ?? '');
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

function sanitizeList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seenIds = new Set();
  const seenLegacy = new Set();
  for (const e of list) {
    const name = cleanName(e && e.name);
    const score = cleanScore(e && e.score);
    if (!name || score === null) continue;
    const id = cleanId(e && e.id);
    if (id) {
      if (seenIds.has(id)) continue; // same submission twice: keep one
      seenIds.add(id);
      out.push({ name, score, id });
    } else {
      // Older rows have no id: collapse exact repeats (same name and score)
      const key = name + '|' + score;
      if (seenLegacy.has(key)) continue;
      seenLegacy.add(key);
      out.push({ name, score });
    }
  }
  return sortAndTrim(out);
}

// What the page gets to see: names and scores only.
function publicList(list) {
  return list.map(({ name, score }) => ({ name, score }));
}

function sortAndTrim(list) {
  // Higher score first; on a tie, the earlier entry keeps its place (stable sort).
  return list.slice().sort((a, b) => b.score - a.score).slice(0, MAX_ENTRIES);
}

export async function getTop(store) {
  const found = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
  return publicList(sanitizeList(found && found.data));
}

// Adds a score if it makes the top 10. Returns { added, entries }.
export async function submitScore(store, rawName, rawScore, rawId) {
  const name = cleanName(rawName);
  const score = cleanScore(rawScore);
  const id = cleanId(rawId);
  if (!name) throw new HttpError(400, 'Name must have 1 to 4 letters or numbers.');
  if (score === null) throw new HttpError(400, 'Score must be a whole number from 1 to ' + MAX_SCORE + '.');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const found = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
    const current = sanitizeList(found && found.data);

    // This exact submission is already on the board (an earlier try went
    // through, or the page sent it twice): report success, add nothing.
    if (id && current.some((e) => e.id === id)) {
      return { added: true, entries: publicList(current) };
    }

    const qualifies = current.length < MAX_ENTRIES || score > current[current.length - 1].score;
    if (!qualifies) return { added: false, entries: publicList(current) };

    const next = sortAndTrim(current.concat(id ? { name, score, id } : { name, score }));
    // Only write if nobody else changed the list since we read it.
    const result = await store.setJSON(KEY, next, found ? { onlyIfMatch: found.etag } : { onlyIfNew: true });
    // Only an explicit "not modified" means someone else wrote first; then we
    // read again and retry (the id check above stops a double add).
    if (!result || result.modified !== false) return { added: true, entries: publicList(next) };
  }
  throw new HttpError(503, 'The leaderboard is busy. Please try again.');
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Turns a web Request into a Response. `store` is injected so tests can fake it.
export async function handleRequest(req, store) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers });

  try {
    if (req.method === 'GET') {
      return json(200, { entries: await getTop(store) });
    }
    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { throw new HttpError(400, 'Send JSON like {"name":"ABCD","score":123}.'); }
      return json(200, await submitScore(store, body && body.name, body && body.score, body && body.id));
    }
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error('leaderboard error', err);
    return json(500, { error: 'Something went wrong.' });
  }
}
