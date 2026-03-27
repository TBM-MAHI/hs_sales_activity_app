// services/activity.service.js
const axios = require('axios');
const logger = require('../utils/logger');

const HUBSPOT_BASE = 'https://api.hubapi.com/crm/v3';
const ACCESS_TOKEN = 'YOUR_HARDCODED_TOKEN';

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

// HubSpot API helpers
async function hubspotGet(url, params = {}) {
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        params,
        timeout: 20000,
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429 && attempt < 4) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
      throw { status: err.response?.status || 500, message: err.response?.data?.message || err.message };
    }
  }
}

async function hubspotPost(url, data) {
  const res = await axios.post(url, data, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  return res.data;
}

function normalizeType(type) {
  const t = String(type).toLowerCase().trim();
  if (t === 'contact' || t === 'contacts') return 'contacts';
  if (t === 'company' || t === 'companies') return 'companies';
  throw { status: 400, message: `Unsupported objectType: ${type}` };
}

// Fetch all activities (cached)
async function fetchActivities(objectType, objectId) {
  const normType = normalizeType(objectType);
  const cacheKey = `${normType}:${objectId}`;
  
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Get activity IDs
  const activityIds = [];
  let after;
  do {
    const data = await hubspotGet(
      `${HUBSPOT_BASE}/objects/${normType}/${objectId}/associations/activities`,
      { limit: 100, after }
    );
    data.results?.forEach(r => r.id && activityIds.push(r.id));
    after = data.paging?.next?.after;
  } while (after);

  // Fetch details in chunks
  const activities = [];
  for (let i = 0; i < activityIds.length; i += 20) {
    const results = await Promise.all(
      activityIds.slice(i, i + 20).map(async (id) => {
        try {
          const data = await hubspotGet(`${HUBSPOT_BASE}/objects/activities/${id}`, {
            properties: 'hs_activity_type,hs_timestamp',
          });
          const type = data.properties?.hs_activity_type?.toUpperCase() || null;
          const ts = data.properties?.hs_timestamp;
          const timestamp = ts ? new Date(Number(ts) || ts).toISOString() : null;
          return type && timestamp ? { type, timestamp } : null;
        } catch {
          return null;
        }
      })
    );
    results.filter(Boolean).forEach(a => activities.push(a));
  }

  setCache(cacheKey, activities);
  return activities;
}

// ─────────────────────────────────────────────────────────────
// EXPORTED FUNCTIONS
// ─────────────────────────────────────────────────────────────

async function getLastActivityType(objectId, objectType) {
  const activities = await fetchActivities(objectType, objectId);
  if (!activities.length) return null;
  
  const sorted = activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return sorted[0].type;
}

async function getFirstActivityType(objectId, objectType) {
  const activities = await fetchActivities(objectType, objectId);
  if (!activities.length) return null;
  
  const sorted = activities.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return sorted[0].type;
}

async function getMostFrequentActivityType(objectId, objectType) {
  const activities = await fetchActivities(objectType, objectId);
  if (!activities.length) return null;

  const counts = new Map();
  const latestByType = new Map();

  activities.forEach(({ type, timestamp }) => {
    counts.set(type, (counts.get(type) || 0) + 1);
    const ts = new Date(timestamp);
    if (!latestByType.get(type) || ts > latestByType.get(type)) {
      latestByType.set(type, ts);
    }
  });

  let result = null, maxCount = 0;
  counts.forEach((count, type) => {
    if (count > maxCount || (count === maxCount && latestByType.get(type) > latestByType.get(result))) {
      result = type;
      maxCount = count;
    }
  });

  return result;
}

async function verifyObjectExists(objectType, objectId) {
  await hubspotGet(`${HUBSPOT_BASE}/objects/${normalizeType(objectType)}/${objectId}`);
}

async function updateProperty(objectType, objectId, propertyName, value) {
  await hubspotPost(`${HUBSPOT_BASE}/objects/${normalizeType(objectType)}/batch/update`, {
    inputs: [
      { 
        id: String(objectId), 
        properties: { 
          [propertyName]: value 

        } 
      }
    ],
  });
}

module.exports = {
  getLastActivityType,
  getFirstActivityType,
  getMostFrequentActivityType,
  verifyObjectExists,
  updateProperty,
};