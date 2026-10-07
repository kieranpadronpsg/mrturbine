import { getStore } from '@netlify/blobs';
import { handleRequest } from '../lib/leaderboard-core.mjs';

// GET  /api/leaderboard                          -> { entries: [{ name, score }, ...] }  (top 10)
// POST /api/leaderboard  {"name":"ABCD","score":123} -> { added, entries }
export default async (req) => {
  const store = getStore({ name: 'leaderboard', consistency: 'strong' });
  return handleRequest(req, store);
};

export const config = { path: '/api/leaderboard' };
