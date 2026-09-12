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
      properties: ['hs_createdate', 'hs_email_direction','hs_email_subject'],
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
  console.log(results);
  // Categorize as we go
  for (const email of results) {
    const direction = email.properties?.hs_email_direction;
    if (direction === 'EMAIL') {
      accumulated.sent.push(email);
    } else if (direction === 'INCOMING_EMAIL') {
      accumulated.received.push(email);
    }
  }

  console.log(`Fetched EMAILS: ${results.length} emails (running total: ${accumulated.sent.length} sent, ${accumulated.received.length} received)`);

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
    console.log(`GET URL ${url}`);
    try {
      const res = await axios.get(url, { headers: authHeaders(accessToken), params, timeout: 20000 });
      console.log(res.data.properties);
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
    console.log(`POST -> ${url}`);
    try {
      const res = await axios.post(url, data, { headers: authHeaders(accessToken), timeout: 20000 });
      if ( url.includes('/batch/update') ) 
        console.log(res.data);
      return res.data;
    } catch (err) {
      console.log(err.response);
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
    console.log(`Cache hit for ${cacheKey}`);
    return cached;
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

        console.log(`Total: ${emails.sent.length} emails_sent, ${emails.received.length} emails_received`);
      } else {
        const response = await hubspotPost(
          `${HUBSPOT_BASE}/objects/${engagementType}/search`,
          accessToken,
          {
            limit: 200,
            properties: ['hs_createdate'],
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
        console.log(`Fetched ${response.total} ${engagementType}`);
        // console.log(engagement_results[engagementType]);
      }
      console.log("🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉🦉");
    } catch (err) {
      console.log(`Failed to fetch ${engagementType}: ${err.message}`);
      engagement_results[engagementType] = [];
    }
    // Rate limit delay
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
  }
  setCache(cacheKey, engagement_results);
  
  if (whichFunction=='getLastActivityType') 
    return engagement_results
  else if (whichFunction == 'MostFrequentActivity')
    return engagement_count;
  
  return engagement_results;
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
      console.log(latest);
    }
  }
  return latest?.type || null;
}

async function getMostFrequentActivityType(objectId, objectType, ctx) {
  const engagementsCount = await fetchAllEngagements(objectType, objectId, 'MostFrequentActivity', ctx);
  console.log("in most frequent->",engagementsCount);  

  const mostFrequentActivityType = Object.entries(engagementsCount)
  .reduce(
    (max, [type, count]) => count > max[1] ? [type, count] : max)[0];
    console.log("\t mostFrequentActivityType:", TYPE_LABELS[mostFrequentActivityType]);
  return mostFrequentActivityType;
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
  verifyObjectExists,
  updateProperty,
};