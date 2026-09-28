// services/myHubspotService.js
/*
 * MY OWN HUBSPOT ACCOUNT - not a client's.
 *
 * Every other file talks to the portal that installed the app with that
 * portal's OAuth token. This file only ever talks to my own portal, with the
 * private-app token in MY_HUB_API_KEY, and is where anything that records app
 * activity on my side belongs.
 *
 * Nothing here throws: it runs after the install has finished, so a failure is
 * logged and swallowed rather than reaching the person installing the app.
 */
const axios = require('axios');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const MY_HUB_API_KEY = process.env.MY_HUB_API_KEY;
const LOG = '[myHubspotService.js]';

const INSTALL_TYPE_PROPERTY = 'contacts_app_install_type';
const USAGE_PROPERTY = 'contacts_activity_app_usage';
const DOMAIN_PROPERTY = 'company_domain';

// The dropdown value written for an install of this app. A second app adds its
// own option here and passes its own value.
const INSTALL_TYPE_VALUE = 'Contacts Activity Tracker App';

/* Created on my portal when missing, and corrected when one already exists with
   the wrong fieldType - company_domain holds a bare domain, so as a url field it
   would reject "acme.com" with INVALID_URL. Stock "contactinformation" group. */
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

/* IANA timezone -> the value HubSpot's stock "Country/Region" (country) property
   expects. Account-info returns a zone like "America/Denver" and no country, so
   this is the only mapping available. An unlisted zone leaves country blank. */
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
  headers: { Authorization: `Bearer ${MY_HUB_API_KEY}`, 'Content-Type': 'application/json' }
});

const log = message => console.log(LOG, message);

// Pull the useful bits out of an axios error so failures name the real cause.
function hsMessage(error) {
  const reason = error.response?.data?.message || error.message;
  return error.response?.status ? `HTTP ${error.response.status} - ${reason}` : reason;
}

/* The installing portal's own domain, lowercased, or null. HubSpot's own
   domains are not a company domain, and the installer's email domain is not
   either: a blank field beats a guessed one. */
const HUBSPOT_OWNED = /(^|\.)(hubspot\.com|hubspotdev\.com|hs-sites\.com)$/i;

function resolveDomain(hubDomain) {
  const domain = String(hubDomain || '').toLowerCase();
  return domain.includes('.') && !HUBSPOT_OWNED.test(domain) ? domain : null;
}

/**
 * Create each property that is missing, and fix the fieldType of one that
 * exists with the wrong one. Returns { [name]: fieldType } as things stand
 * afterwards, so the caller knows what a value will be checked against.
 */
async function ensureMyProperties() {
  const fieldTypes = {};

  for (const property of MY_PROPERTIES) {
    const url = `${HUBSPOT_BASE}/crm/v3/properties/contacts/${property.name}`;

    try {
      const { data } = await axios.get(url, myHeaders());
      fieldTypes[property.name] = data.fieldType;

      if (data.fieldType !== property.fieldType) {
        try {
          await axios.patch(url, { type: property.type, fieldType: property.fieldType }, myHeaders());
          fieldTypes[property.name] = property.fieldType;
          log(`\t ${property.name} was a "${data.fieldType}" field - changed it to "${property.fieldType}"`);
        } catch (patchError) {
          log(`\t ${property.name} is a "${data.fieldType}" field and could not be changed - ${hsMessage(patchError)}`);
        }
      }
      continue;
    } catch (err) {
      if (err.response?.status !== 404) {
        log(`\t could not check ${property.name} - ${hsMessage(err)}`);
        continue;
      }
    }

    try {
      await axios.post(
        `${HUBSPOT_BASE}/crm/v3/properties/contacts`,
        { groupName: 'contactinformation', ...property },
        myHeaders()
      );
      fieldTypes[property.name] = property.fieldType;
      log(`\t created property ${property.name} on my portal`);
    } catch (err) {
      log(`\t could not create ${property.name} - ${hsMessage(err)}`);
    }
  }

  return fieldTypes;
}

/** The contact on my portal with this email, or null. */
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
    log(`\t contact lookup failed for ${email} - ${hsMessage(err)}`);
    return null;
  }
}

/**
 * Record an app install as a contact on MY portal. Runs once the install has
 * already completed. Never throws and never rejects - the worst case is a
 * logged failure and { ok: false }.
 *
 * Only values HubSpot actually gives us are written; anything unknown is left
 * out of the payload, which leaves the field blank rather than wrong.
 *
 * @param {object}  install
 * @param {number}  install.portalId     the portal that installed
 * @param {string}  install.user_email   installer's email (from introspection)
 * @param {string} [install.hub_domain]  installing portal's domain
 * @param {string} [install.timeZone]    e.g. "America/Denver"
 */
async function recordAppInstall({ portalId, user_email, hub_domain, timeZone } = {}) {
  if (!MY_HUB_API_KEY) {
    log('\n[My Hubspot Portal] ERROR: MY_HUB_API_KEY is missing from .env - install not recorded\n');
    return { ok: false, error: 'MY_HUB_API_KEY missing' };
  }

  // Email is the contact's identity here - without it there is nothing to
  // create, and nothing to match an existing record on.
  if (!user_email) {
    log(`\n[My Hubspot Portal] ERROR: no installer email for portal ${portalId} - install not recorded\n`);
    return { ok: false, error: 'no installer email' };
  }

  try {
    const fieldTypes = await ensureMyProperties();

    const domain = resolveDomain(hub_domain);
    const country = TIMEZONE_COUNTRY[timeZone] || null;
    // The only name HubSpot gives us is the email address. Last name stays blank.
    const firstname = user_email.split('@')[0] || null;

    if (!domain) log(`\t no usable portal domain for portal ${portalId} - Company Domain left blank`);
    if (timeZone && !country) log(`\t timezone "${timeZone}" is not in TIMEZONE_COUNTRY - Country/Region left blank`);

    const properties = { email: user_email, [INSTALL_TYPE_PROPERTY]: INSTALL_TYPE_VALUE };
    if (firstname) properties.firstname = firstname;
    if (country) properties.country = country;
    if (domain) {
      // Always bare - "acme-corp.com", never "https://acme-corp.com". If the
      // fieldType fix above failed the field is skipped rather than prefixed.
      if (fieldTypes[DOMAIN_PROPERTY] === 'url') log(`\t ${DOMAIN_PROPERTY} is still a url field - skipping it`);
      else properties[DOMAIN_PROPERTY] = domain;
    }

    const existing = await findContactByEmail(user_email);
    let contactId;

    if (existing) {
      // usageCount is a running total: a re-install must not reset it, so the
      // property is left out of the update entirely.
      contactId = existing.id;
      await axios.patch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}`, { properties }, myHeaders());
    } else {
      properties[USAGE_PROPERTY] = 0;
      const { data } = await axios.post(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, { properties }, myHeaders());
      contactId = data.id;
    }

    log(
      `\n[My Hubspot Portal] Install recorded - ${existing ? 'updated' : 'created'} contact ${contactId}` +
      `\n\tportal    : ${portalId}` +
      `\n\temail     : ${user_email}` +
      `\n\tfirstname : ${firstname || 'blank'} (last name always blank)` +
      `\n\tdomain    : ${properties[DOMAIN_PROPERTY] || 'blank'}` +
      `\n\tcountry   : ${country || 'blank'} (from ${timeZone || 'no timezone'})` +
      `\n\tusage     : ${existing ? `left at ${existing.properties?.[USAGE_PROPERTY] ?? 0}` : 0}\n`
    );
    return { ok: true, contactId, created: !existing };

  } catch (err) {
    log(`\n[My Hubspot Portal] ERROR: could not record the install for portal ${portalId}\n\t${hsMessage(err)}\n`);
    return { ok: false, error: hsMessage(err) };
  }
}

module.exports = { recordAppInstall };
