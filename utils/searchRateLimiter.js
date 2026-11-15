// utils/searchRateLimiter.js
//
// HubSpot's CRM search endpoints allow 5 requests/second per portal (per app),
// shared across EVERY request this server is handling for that portal. A bulk
// workflow enrollment fires hundreds of action calls at once, so spacing
// searches inside one request is not enough - they have to queue per portal.
//
// Each portal gets a "next free slot" time. A search reserves the next slot and
// waits for it. If the queue is already longer than MAX_WAIT_MS, the search is
// refused with a 429 instead: the action call is answered with Retry-After and
// HubSpot retries it later, rather than our request hanging until HubSpot's
// action timeout fires.
//
// In-memory: correct for a single Node process. If the app is ever scaled to
// several instances, this state has to move to a shared store (e.g. Redis).

// 250ms between searches = 4/sec, leaving headroom under HubSpot's 5/sec.
const SEARCH_INTERVAL_MS = 250;
// Longest a search may sit in the queue before we push back to HubSpot.
const MAX_WAIT_MS = 8000;

const nextSlot = new Map(); // portalId -> epoch ms of the next free slot

function rateLimitError(retryAfterMs) {
  return {
    status: 429,
    message: 'HubSpot search rate limit reached for this portal - retry later',
    retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)), // seconds
  };
}

/** Wait for this portal's next search slot, or throw a 429 if the queue is too long. */
async function acquireSearchSlot(portalId) {
  const key = String(portalId);
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(key) || 0);
  const wait = slot - now;

  if (wait > MAX_WAIT_MS) throw rateLimitError(wait);

  nextSlot.set(key, slot + SEARCH_INTERVAL_MS);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

/** HubSpot said 429 anyway: hold all of this portal's searches for a moment. */
function penalize(portalId, ms = 1000) {
  const key = String(portalId);
  nextSlot.set(key, Math.max(nextSlot.get(key) || 0, Date.now() + ms));
}

// Drop idle portals so the map does not grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, t] of nextSlot) if (t < now - 60000) nextSlot.delete(key);
}, 60000).unref();

module.exports = { acquireSearchSlot, penalize, rateLimitError };
