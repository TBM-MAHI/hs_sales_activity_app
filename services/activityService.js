// services/activity.service.js
const axios = require('axios');
const logger = require('../utils/logger');

const HUBSPOT_BASE = 'https://api.hubapi.com/crm/v3';

// The token is no longer baked in: every call is made with the OAuth token of
// the portal the request came from, resolved (and refreshed) by tokenService.
const authHeaders = accessToken => ({
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json'
});

// Engagement types and their labels
const ENGAGEMENT_TYPES = ['calls', 'emails', 'meetings', 'notes', 'tasks'];
const TYPE_LABELS = {
  calls: 'Call',
  emails_sent: 'Email Sent',
  emails_received: 'Email Received',
  meetings: 'Meeting',
  notes: 'Note',
  tasks: 'Task',
};

/* Properties pulled back for each engagement type. One search per type already
   runs, so asking for the type-specific date here means the date / outcome
   options cost no extra HubSpot calls - they all read the same cached result
   set. */
const ENGAGEMENT_PROPERTIES = {
  calls: ['hs_createdate', 'hs_timestamp', 'hs_call_disposition', 'hs_call_title'],
  meetings: ['hs_createdate', 'hs_timestamp', 'hs_meeting_start_time', 'hs_meeting_title'],
  notes: ['hs_createdate', 'hs_timestamp'],
  tasks: ['hs_createdate', 'hs_timestamp'],
};

// Date properties to read per question, best first.
const MEETING_DATE_PROPS = ['hs_meeting_start_time', 'hs_timestamp', 'hs_createdate'];
const CALL_DATE_PROPS = ['hs_timestamp', 'hs_createdate'];

/* HubSpot needs *something* written back or the workflow action leaves the
   target property untouched, so "nothing found" is a single space. */
const BLANK = ' ';

/* hs_call_disposition comes back as a GUID. HubSpot's stock dispositions are
   the same in every portal; a portal can add its own, which is what the
   /calling/v1/dispositions lookup below picks up. This table is the fallback
   for when that call is not permitted. */
const DEFAULT_CALL_DISPOSITIONS = {
  '9d9162e7-6cf3-4944-bf63-4dff82258764': 'Busy',
  'f240bbac-87c9-4f6e-bf70-924b57d47db7': 'Connected',
  'a4c4c377-d246-4b32-a13b-75a56a4cd0ff': 'Left live message',
  'b2cf5968-551e-4856-9783-52b3da59a7d0': 'Left voicemail',
  '73a0d17f-1163-4015-bdd5-ec830791da20': 'No answer',
  '17b47fee-58de-441e-a44c-c6300d46f273': 'Wrong number',
};

// Rate limit: 5 req/sec - use 250ms delay for safety
const RATE_LIMIT_DELAY = 250;

// Cache (5 min TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL, data });
}
/**
 * Recursively fetch all emails with pagination and split by direction
 */
async function fetchAllEmailsPaginated(assocType, objectId, accessToken, after = undefined, accumulated = { sent: [], received: [] }) {
  const response = await hubspotPost(
    `${HUBSPOT_BASE}/objects/emails/search`,
    accessToken,
    {
      limit: 200,
      after,
      properties: ['hs_createdate', 'hs_timestamp', 'hs_email_direction', 'hs_email_subject'],
      filters: [
        {
          propertyName: `associations.${assocType}`,
          operator: 'EQ',
          value: objectId,
        },
      ],
      sorts: [
        { propertyName: 'hs_createdate', direction: 'DESCENDING' }
      ],
    }
  );
  const results = response.results || [];
  console.log('[activityService.js]', results);
  // Categorize as we go
  for (const email of results) {
    const direction = email.properties?.hs_email_direction;
    if (direction === 'EMAIL') {
      accumulated.sent.push(email);
    } else if (direction === 'INCOMING_EMAIL') {
      accumulated.received.push(email);
    }
  }

  console.log('[activityService.js]', `Fetched EMAILS: ${results.length} emails (running total: ${accumulated.sent.length} sent, ${accumulated.received.length} received)`);

  // Check for next page
  const nextAfter = response.paging?.next?.after;

  if (nextAfter) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY)); // Rate limit
    return fetchAllEmailsPaginated(assocType, objectId, accessToken, nextAfter, accumulated); // Recurse
  }
  return accumulated; // Done - return final result
}
/*  
   HubSpot API helpers
*/

async function hubspotGet(url, accessToken, params = {}) {
  for (let attempt = 0; attempt <= 4; attempt++) {
    console.log('[activityService.js]', `GET URL ${url}`);
    try {
      const res = await axios.get(url, { headers: authHeaders(accessToken), params, timeout: 20000 });
      console.log('[activityService.js]', res.data.properties);
      return res.data;
    } catch (err) {
      //console.log(err.response);
      if (err.response?.status === 429 && attempt < 4) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
      throw { status: err.response?.status || 500, message: err.response?.data?.message || err.message };
    }
  }
}

async function hubspotPost(url, accessToken, data) {
  for (let attempt = 0; attempt <= 4; attempt++) {
    console.log('[activityService.js]', `POST -> ${url}`);
    try {
      const res = await axios.post(url, data, { headers: authHeaders(accessToken), timeout: 20000 });
      if ( url.includes('/batch/update') ) 
        console.log('[activityService.js]', res.data);
      return res.data;
    } catch (err) {
      console.log('[activityService.js]', `POST ${url} failed: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
      if (err.response?.status === 429 && attempt < 4) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
      throw { status: err.response?.status || 500, message: err.response?.data?.message || err.message };
    }
  }
}

function normalizeType(type) {
  const t = String(type).toLowerCase().trim();
  if (t === 'contact' || t === 'contacts') return 'contacts';
  if (t === 'company' || t === 'companies') return 'companies';
  throw { status: 400, message: `Unsupported objectType: ${type}` };
}

// ─────────────────────────────────────────────────────────────
// FETCH ALL ENGAGEMENTS (searches each type's API)
// ─────────────────────────────────────────────────────────────

async function fetchAllEngagements(objectType, objectId, whichFunction, { portalId, accessToken }) {
  const normType = normalizeType(objectType);
  // The portal is part of the key - two portals must never share cached records.
  const cacheKey = `engagements:${portalId}:${normType}:${objectId}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log('[activityService.js]', `Cache hit for ${cacheKey}`);
    return pickShape(cached, whichFunction);
  }
  // Association filter uses singular object form
  const assocType = normType === 'contacts' ? 'contact' : 'company';
  const engagement_results = {};
  let engagement_count = {};

  for (const engagementType of ENGAGEMENT_TYPES) {
    try {
       if (engagementType === 'emails') {
        // Use recursive pagination for emails
        const emails = await fetchAllEmailsPaginated(assocType, objectId, accessToken);
        
        engagement_results['emails_sent'] = emails.sent;
        engagement_results['emails_received'] = emails.received;
        engagement_count['emails_sent'] = emails.sent.length;
        engagement_count['emails_received'] = emails.received.length;

        console.log('[activityService.js]', `Total: ${emails.sent.length} emails_sent, ${emails.received.length} emails_received`);
      } else {
        const response = await hubspotPost(
          `${HUBSPOT_BASE}/objects/${engagementType}/search`,
          accessToken,
          {
            limit: 200,
            properties: ENGAGEMENT_PROPERTIES[engagementType] || ['hs_createdate'],
            filters: [
              {
                propertyName: `associations.${assocType}`,
                operator: 'EQ',
                value: objectId,
              },
            ],
            sorts: [
              { propertyName: 'hs_createdate', direction: 'DESCENDING' }
            ],
          }
        );
        engagement_results[engagementType] = response.results || [];
        engagement_count[engagementType] = response.total || 0;
        console.log('[activityService.js]', `Fetched ${response.total} ${engagementType}`);
        console.log(engagement_results[engagementType]);
      }
      console.log('[activityService.js]', "🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉");
    } catch (err) {
      console.log('[activityService.js]', `Failed to fetch ${engagementType}: ${err.message}`);
      engagement_results[engagementType] = [];
    }
    // Rate limit delay
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
  }
  // Both shapes are cached together: the counts used to be recomputed on every
  // call and thrown away on a cache hit, which handed MostFrequentActivity the
  // record arrays instead of the counts.
  const bundle = { results: engagement_results, counts: engagement_count };
  setCache(cacheKey, bundle);

  return pickShape(bundle, whichFunction);
}

// Counts for the "most frequent" question, the records themselves for the rest.
function pickShape(bundle, whichFunction) {
  return whichFunction === 'MostFrequentActivity' ? bundle.counts : bundle.results;
}
// ─────────────────────────────────────────────────────────────
// HELPER: Parse timestamp from engagement record
// ─────────────────────────────────────────────────────────────

function parseTimestamp(record) {
  const tsRaw =record.properties.hs_createdate;
  if (!tsRaw) 
    return null;
  const ts = new Date(Number(tsRaw) || tsRaw);
    //console.log("logging ts from parseTimestamp",ts);
  return isNaN(ts.getTime()) ? null : ts;
}

/**
 * Read a date off an engagement, trying each property in order. HubSpot sends
 * these as epoch-millisecond strings on search results and as ISO strings
 * elsewhere, so both are accepted.
 */
function engagementDate(record, propNames) {
  for (const name of propNames) {
    const raw = record?.properties?.[name];
    if (!raw) continue;
    const date = new Date(Number(raw) || raw);
    if (!isNaN(date.getTime())) 
      return date;
  }
  return null;
}

/**
 * The most recent record in a set, by the given date properties.
 * The search already sorts on hs_createdate, but a meeting's start time is its
 * own property - the newest-created meeting is not always the latest one - so
 * the whole page is ranked rather than trusting records[0].
 */
function latestRecord(records, propNames) {
  let best = null;
  for (const record of records || []) {
    const date = engagementDate(record, propNames);
    if (!date) continue;
    if (!best || date > best.date) best = { record, date };
  }
  return best;
}

// MM/DD/YYYY, read in UTC so the answer does not shift with the server's clock.
function toUSDate(date) {
  if (!date) return BLANK;
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC'
  }).format(date);
}

/**
 * Turn a disposition GUID into its label. The portal's own list is fetched
 * once and cached; if that call is refused the stock table still covers the
 * six built-in outcomes, and an unknown GUID is returned unchanged rather than
 * being reported as blank.
 */
async function resolveCallDisposition(dispositionId, { portalId, accessToken }) {
  const cacheKey = `dispositions:${portalId}`;
  let dispositions = getCached(cacheKey);

  if (!dispositions) {
    dispositions = { ...DEFAULT_CALL_DISPOSITIONS };
    try {
      const data = await hubspotGet('https://api.hubapi.com/calling/v1/dispositions', accessToken);
      for (const entry of data || []) {
        if (entry?.id) dispositions[entry.id] = entry.label;
      }
    } catch (err) {
      console.log('[activityService.js]', `Could not read this portal's call dispositions - using the built-in list: ${err.message}`);
    }
    setCache(cacheKey, dispositions);
  }

  return dispositions[dispositionId] || dispositionId;
}

// ─────────────────────────────────────────────────────────────
// EXPORTED FUNCTIONS
// ─────────────────────────────────────────────────────────────

async function getLastActivityType(objectId, objectType, ctx) {
  const engagements = await fetchAllEngagements(objectType, objectId, 'LastActivityType', ctx);
  //console.log(engagements);
  /* engagements = {
                      meetings: [],
                      notes: [],
                      calls: [{ properties: { hs_timestamp: '2024-06-01T12:00:00Z' } }],
                      emails: [{ properties: { hs_timestamp: '2024-06-02T12:00:00Z' } }],
                      tasks: []
  }
   */
  let latest = null;

  for (const [engagementType, records] of Object.entries(engagements)) {
    if (!records.length) continue; // Skip empty arrays
    
    const ts = parseTimestamp(records[0]); // Only check first record (already sorted)
    if (!ts) continue;
    if (!latest || ts > latest.timestamp) {
      latest = { type: TYPE_LABELS[engagementType], timestamp: ts };
      console.log('[activityService.js]', latest);
    }
  }
  return latest?.type || null;
}

async function getMostFrequentActivityType(objectId, objectType, ctx) {
  const engagementsCount = await fetchAllEngagements(objectType, objectId, 'MostFrequentActivity', ctx);
  console.log('[activityService.js]', "in most frequent->",engagementsCount);  

  const mostFrequentActivityType = Object.entries(engagementsCount)
  .reduce(
    (max, [type, count]) => count > max[1] ? [type, count] : max)[0];
    console.log('[activityService.js]', "\t mostFrequentActivityType:", TYPE_LABELS[mostFrequentActivityType]);
  return mostFrequentActivityType;
}

/**
 * Date of the most recent meeting, US formatted. Blank when there is none.
 */
async function getLastMeetingDate(objectId, objectType, ctx) {
  const engagements = await fetchAllEngagements(objectType, objectId, 'LastMeetingDate', ctx);
  const latest = latestRecord(engagements.meetings, MEETING_DATE_PROPS);

  console.log('[activityService.js]', `\t last meeting: ${latest ? latest.date.toISOString() : 'none'}`);
  return toUSDate(latest?.date);
}

/**
 * Date of the most recent call, US formatted. Blank when there is none.
 */
async function getLastCallDate(objectId, objectType, ctx) {
  const engagements = await fetchAllEngagements(objectType, objectId, 'LastCallDate', ctx);
  const latest = latestRecord(engagements.calls, CALL_DATE_PROPS);

  console.log('[activityService.js]', `\t last call: ${latest ? latest.date.toISOString() : 'none'}`);
  return toUSDate(latest?.date);
}

/**
 * Outcome/disposition logged on the most recent call. Blank when there is no
 * call, or when the call was logged without an outcome.
 */
async function getLastCallOutcome(objectId, objectType, ctx) {
  const engagements = await fetchAllEngagements(objectType, objectId, 'LastCallOutcome', ctx);
  const latest = latestRecord(engagements.calls, CALL_DATE_PROPS);

  const disposition = latest?.record?.properties?.hs_call_disposition;
  if (!disposition) {
    console.log('[activityService.js]', '\t last call outcome: none recorded');
    return BLANK;
  }

  const outcome = await resolveCallDisposition(disposition, ctx);
  console.log('[activityService.js]', `\t last call outcome: ${outcome}`);
  return outcome;
}

async function verifyObjectExists(objectType, objectId, { accessToken }) {
  await hubspotGet(`${HUBSPOT_BASE}/objects/${normalizeType(objectType)}/${objectId}`, accessToken);
}

async function updateProperty(objectType, objectId, propertyName, value, { accessToken }) {
  await hubspotPost(`${HUBSPOT_BASE}/objects/${normalizeType(objectType)}/batch/update`, accessToken, {
    inputs: [
      { 
        id: String(objectId), 
        properties: { [propertyName]: value } 
      }
    ],
  });
}

module.exports = {
  getLastActivityType,
  getMostFrequentActivityType,
  getLastMeetingDate,
  getLastCallDate,
  getLastCallOutcome,
  verifyObjectExists,
  updateProperty,
};