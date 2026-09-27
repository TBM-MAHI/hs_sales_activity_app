// services/myHubspotService.js
const axios = require('axios');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const MY_HUB_API_KEY = process.env.MY_HUB_API_KEY;

// The install contact's custom properties on MY portal.
const INSTALL_TYPE_PROPERTY = 'contacts_app_install_type';
const USAGE_PROPERTY = 'contacts_activity_app_usage';
const DOMAIN_PROPERTY = 'company_domain';

// The dropdown value written for an install of this app. A second app would add
// its own option here and pass its own value.
const INSTALL_TYPE_VALUE = 'Contacts Activity Tracker App';

/* Properties created on my portal if they are not already there, so a fresh
   copy of this account does not need them set up by hand. They go in the stock
   "contactinformation" group, which always exists. */
const MY_PROPERTIES = [
  {
    name: INSTALL_TYPE_PROPERTY,
    label: 'App Install Type',
    type: 'enumeration',
    fieldType: 'select',
    options: [{ label: INSTALL_TYPE_VALUE, value: INSTALL_TYPE_VALUE, displayOrder: 0 }]
  },
  { name: USAGE_PROPERTY, label: 'Activity App Usage', type: 'number', fieldType: 'number' },
  { name: DOMAIN_PROPERTY, label: 'Company Domain', type: 'string', fieldType: 'text' }
];

/* IANA timezone -> the value HubSpot's stock "Country/Region" (country)
   property expects. HubSpot hands back a zone like "America/Denver" and has no
   country field of its own, so this is the only mapping available. Unlisted
   zones leave country unset rather than guessing. */
const TIMEZONE_COUNTRY = {
  'America/New_York': 'United States',
  'America/Detroit': 'United States',
  'America/Chicago': 'United States',
  'America/Denver': 'United States',
  'America/Phoenix': 'United States',
  'America/Los_Angeles': 'United States',
  'America/Anchorage': 'United States',
  'Pacific/Honolulu': 'United States',
  'America/Toronto': 'Canada',
  'America/Vancouver': 'Canada',
  'America/Edmonton': 'Canada',
  'America/Winnipeg': 'Canada',
  'America/Halifax': 'Canada',
  'America/Mexico_City': 'Mexico',
  'America/Sao_Paulo': 'Brazil',
  'America/Bogota': 'Colombia',
  'America/Argentina/Buenos_Aires': 'Argentina',
  'Europe/London': 'United Kingdom',
  'Europe/Dublin': 'Ireland',
  'Europe/Paris': 'France',
  'Europe/Berlin': 'Germany',
  'Europe/Madrid': 'Spain',
  'Europe/Rome': 'Italy',
  'Europe/Amsterdam': 'Netherlands',
  'Europe/Brussels': 'Belgium',
  'Europe/Zurich': 'Switzerland',
  'Europe/Vienna': 'Austria',
  'Europe/Stockholm': 'Sweden',
  'Europe/Oslo': 'Norway',
  'Europe/Copenhagen': 'Denmark',
  'Europe/Helsinki': 'Finland',
  'Europe/Warsaw': 'Poland',
  'Europe/Prague': 'Czechia',
  'Europe/Lisbon': 'Portugal',
  'Europe/Athens': 'Greece',
  'Europe/Istanbul': 'Turkey',
  'Europe/Moscow': 'Russia',
  'Europe/Kiev': 'Ukraine',
  'Asia/Kolkata': 'India',
  'Asia/Calcutta': 'India',
  'Asia/Karachi': 'Pakistan',
  'Asia/Dhaka': 'Bangladesh',
  'Asia/Dubai': 'United Arab Emirates',
  'Asia/Riyadh': 'Saudi Arabia',
  'Asia/Jerusalem': 'Israel',
  'Asia/Singapore': 'Singapore',
  'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Shanghai': 'China',
  'Asia/Tokyo': 'Japan',
  'Asia/Seoul': 'South Korea',
  'Asia/Jakarta': 'Indonesia',
  'Asia/Manila': 'Philippines',
  'Asia/Bangkok': 'Thailand',
  'Asia/Kuala_Lumpur': 'Malaysia',
  'Australia/Sydney': 'Australia',
  'Australia/Melbourne': 'Australia',
  'Australia/Brisbane': 'Australia',
  'Australia/Perth': 'Australia',
  'Pacific/Auckland': 'New Zealand',
  'Africa/Johannesburg': 'South Africa',
  'Africa/Lagos': 'Nigeria',
  'Africa/Nairobi': 'Kenya',
  'Africa/Cairo': 'Egypt'
};

const myHeaders = () => ({
  headers: {
    Authorization: `Bearer ${MY_HUB_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Pull the useful bits out of an axios error so failures name the real cause.
function hsMessage(error) {
  const body = error.response?.data;
  const reason = body?.message || error.message;
  return error.response?.status ? `HTTP ${error.response.status} - ${reason}` : reason;
}

/* HubSpot's own domains are not the installer's company domain, so they are
   never written to company_domain. */
const HUBSPOT_OWNED = /(^|\.)(hubspot\.com|hubspotdev\.com|hs-sites\.com)$/i;

function isRealDomain(domain) {
  return Boolean(domain) && domain.includes('.') && !HUBSPOT_OWNED.test(domain);
}

/**
 * The installing portal's own domain, or null. Deliberately not guessed from
 * the installer's email address: a personal or free-mail address is not the
 * company domain, and a blank field is better than a wrong one.
 */
function resolveDomain(hubDomain) {
  return isRealDomain(hubDomain) ? hubDomain.toLowerCase() : null;
}

/**
 * The installer's real name, read from the CLIENT portal with the client's own
 * token. Needs settings.users.read, which this app does not currently request,
 * so a 403 here is expected and leaves the name fields blank.
 */
async function fetchInstallerName(userId, clientAccessToken) {
  if (!userId || !clientAccessToken) return null;

  try {
    const { data } = await axios.get(
      `${HUBSPOT_BASE}/settings/v3/users/${userId}`,
      { headers: { Authorization: `Bearer ${clientAccessToken}` } }
    );
    return { firstname: data.firstName || null, lastname: data.lastName || null };
  } catch (err) {
    console.log('[myHubspotService.js]', `\t installer name unavailable (${hsMessage(err)}) - leaving the name blank`);
    return null;
  }
}

/**
 * Create the three custom properties on MY portal when they are missing. Each
 * is checked first, so this is safe to run on every install.
 */
async function ensureMyProperties() {
  for (const property of MY_PROPERTIES) {
    try {
      await axios.get(`${HUBSPOT_BASE}/crm/v3/properties/contacts/${property.name}`, myHeaders());
      continue; // already there
    } catch (err) {
      if (err.response?.status !== 404) {
        console.log('[myHubspotService.js]', `\t could not check ${property.name} - ${hsMessage(err)}`);
        continue;
      }
    }

    try {
      await axios.post(
        `${HUBSPOT_BASE}/crm/v3/properties/contacts`,
        { groupName: 'contactinformation', ...property },
        myHeaders()
      );
      console.log('[myHubspotService.js]', `\t created property ${property.name} on my portal`);
    } catch (err) {
      console.log('[myHubspotService.js]', `\t could not create ${property.name} - ${hsMessage(err)}`);
    }
  }
}

/** Find an existing contact on my portal by email. Null when there is none. */
async function findContactByEmail(email) {
  try {
    const { data } = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      {
        limit: 1,
        properties: [USAGE_PROPERTY],
        filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
      },
      myHeaders()
    );
    return data.results?.[0] || null;
  } catch (err) {
    console.log('[myHubspotService.js]', `\t contact lookup failed for ${email} - ${hsMessage(err)}`);
    return null;
  }
}

/**
 * Record an app install as a contact on MY portal.
 *
 * Called once the install has already completed, with the details gathered
 * during it. Never throws and never returns a rejected promise - the worst
 * case is a logged failure.
 *
 * @param {object}  install
 * @param {number}  install.portalId            the portal that installed
 * @param {string}  install.user_email          installer's email (from introspection)
 * @param {string} [install.hub_domain]         installing portal's domain
 * @param {string} [install.timeZone]           e.g. "America/Denver"
 * @param {number} [install.user_id]            installer's HubSpot user id
 * @param {string} [install.clientAccessToken]  client token, for the name lookup
 */
async function recordAppInstall(install = {}) {
  const { portalId, user_email, hub_domain, timeZone, user_id, clientAccessToken } = install;

  if (!MY_HUB_API_KEY) {
    console.log('[myHubspotService.js]', '\n[MyPortal] ERROR: MY_HUB_API_KEY is missing from .env - install not recorded\n');
    return { ok: false, error: 'MY_HUB_API_KEY missing' };
  }

  // Email is the contact's identity on my portal - without it there is nothing
  // to create or to match an existing record on.
  if (!user_email) {
    console.log('[myHubspotService.js]', `\n[MyPortal] ERROR: no installer email for portal ${portalId} - install not recorded\n`);
    return { ok: false, error: 'no installer email' };
  }

  try {
    await ensureMyProperties();

    const domain = resolveDomain(hub_domain);
    const named = await fetchInstallerName(user_id, clientAccessToken) || {};
    const country = TIMEZONE_COUNTRY[timeZone] || null;

    if (!domain) {
      console.log('[myHubspotService.js]', `\t no usable portal domain for portal ${portalId} - leaving Company Domain blank`);
    }

    if (timeZone && !country) {
      console.log('[myHubspotService.js]', `\t timezone "${timeZone}" is not in TIMEZONE_COUNTRY - leaving Country/Region unset`);
    }

    // Only non-empty values are sent, so a blank guess never overwrites
    // something better already on the record.
    const properties = {
      email: user_email,
      [INSTALL_TYPE_PROPERTY]: INSTALL_TYPE_VALUE
    };
    if (named.firstname) properties.firstname = named.firstname;
    if (named.lastname) properties.lastname = named.lastname;
    if (country) properties.country = country;
    if (domain) properties[DOMAIN_PROPERTY] = domain;

    const existing = await findContactByEmail(user_email);

    if (existing) {
      // Usage is deliberately left alone on an existing contact: it is a
      // running total and a re-install must not reset it to 0.
      await axios.patch(
        `${HUBSPOT_BASE}/crm/v3/objects/contacts/${existing.id}`,
        { properties },
        myHeaders()
      );
      console.log('[myHubspotService.js]',
        `\n[My Hubspot Portal] Install recorded - updated existing contact ${existing.id}` +
        `\n\tportal       : ${portalId}` +
        `\n\temail        : ${user_email}` +
        `\n\tname         : ${[named.firstname, named.lastname].filter(Boolean).join(' ') || 'blank'}` +
        `\n\tdomain       : ${domain || 'blank'}` +
        `\n\tcountry      : ${country || 'blank'} (from ${timeZone || 'no timezone'})` +
        `\n\tusage        : left at ${existing.properties?.[USAGE_PROPERTY] ?? '0'}\n`
      );
      return { ok: true, contactId: existing.id, created: false };
    }

    properties[USAGE_PROPERTY] = 0;
    const { data } = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts`,
      { properties },
      myHeaders()
    );
    console.log('[myHubspotService.js]',
      `\n[My Hubspot Portal] Install recorded - created contact ${data.id}` +
      `\n\temail        : ${user_email}` +
      `\n\tname         : ${[named.firstname, named.lastname].filter(Boolean).join(' ') || 'blank'}` +
      `\n\tdomain       : ${domain || 'blank'}` +
      `\n\tcountry      : ${country || 'blank'} (from ${timeZone || 'no timezone'})` +
      `\n\tusage        : 0\n`
    );
    return { ok: true, contactId: data.id, created: true };

  } catch (err) {
    console.log('[myHubspotService.js]', `\n[MyPortal] ERROR: could not record the install for portal ${portalId}\n\t${hsMessage(err)}\n`);
    return { ok: false, error: hsMessage(err) };
  }
}

module.exports = {
  recordAppInstall,
  // exported for tests / reuse by later additions to this file
  resolveDomain,
  TIMEZONE_COUNTRY
};
