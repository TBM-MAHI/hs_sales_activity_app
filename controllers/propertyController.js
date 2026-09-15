const axios = require('axios');
const logger = require('../utils/logger');

const getProperties = async (req, res) => {
    try {
        // Get objectType from query parameters (default to 'contacts')
        const objectType = req.query.objectType || 'contacts';
        // Get access token
        const accessToken = await getAccessToken(req);
       // const accessToken = process.env.TEMP_TEST_API_KEY; // Use API key for testing if OAuth is not set up
        console.log(accessToken);
        if (!accessToken) {
            return res.status(401).json({
                error: 'No access token available. Please authenticate first.'
            });
        }

        const headers = {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };

        const apiUrl = `https://api.hubapi.com/crm/v3/properties/${objectType}`;
        const response = await axios.get(apiUrl, { headers });

        // Format the response
        const properties = (response.data.results || []).filter(
            property => property.fieldType === 'text' && !property.hubspotDefined
        );
        //console.log(properties);
        const custom_text_properties = properties.map(property => ({
            label: property.label,
            value: property.name
        }));
        logger.info(`Fetched ${custom_text_properties.length} text properties for ${objectType}`);

        return res.status(200).json({
            options: custom_text_properties
        });

    } catch (error) {
        logger.error(`Error fetching properties: ${error.message}`);
        if (error.response) {
            // HubSpot API error
            console.log(error.response.data);
            return res.status(error.response.status).json({
                error: error.response.data.message || 'HubSpot API error'
            });
        } else {
            return res.status(500).json({
                error: 'Internal server error'
            });
        }
    }
};

const HUBSPOT_PROPERTIES_API = 'https://api.hubapi.com/crm/v3/properties';
const OBJECT_TYPES = ['contacts', 'companies'];
const GROUP_NAME = 'sales_activity_tracking';
const GROUP_LABEL = 'Sales Activity Tracking';

const PROPERTIES = [
    ['last_activity_type', 'Last Activity Type'],
    ['first_activity_type', 'First Activity Type'],
    ['most_occurred_activity', 'Most Occurred Activity'],
    ['last_activity_done_by', 'Last Activity Done By'],
    ['last_call_outcome', 'Last Call Outcome']
];

const authHeaders = accessToken => ({
    headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    }
});

// Pull the useful bits out of an axios error so failures name the real cause.
function hsError(error) {
    const { status, data } = error.response || {};
    return {
        status: status || 0,
        message: data?.message || error.message
    };
}

const describe = ({ status, message,  }) => `HTTP ${status} - ${message}`;

/**
 * Read a single property back. Returns the property, or null when HubSpot
 * says it does not exist. Pass archived=true to look for the archived copy:
 * an archived property still owns its name, so re-creating it answers 409
 * while the property stays invisible in the UI. That is the case that used
 * to be swallowed and reported as success.
 */
async function fetchProperty(objectType, name, accessToken, archived = false) {
    try {
        const { data } = await axios.get(
            `${HUBSPOT_PROPERTIES_API}/${objectType}/${name}?archived=${archived}`,
            authHeaders(accessToken)
        );
        return { property: data };
    } catch (error) {
        // 404 is a real answer: the property is not there. Anything else means
        // the read itself failed and must not be reported as "missing".
        if (error.response?.status === 404) 
            return { property: null };
        return { property: null, error: hsError(error) };
    }
}

/**
 * Make sure the property group exists. A 409 is only accepted once we have
 * actually read the group back.
 */
async function ensureGroup(objectType, accessToken) {
    try {
        await axios.post(
            `${HUBSPOT_PROPERTIES_API}/${objectType}/groups`,
            { name: GROUP_NAME, label: GROUP_LABEL, displayOrder: -1 },
            authHeaders(accessToken)
        );
        return { ok: true, state: 'created' };
    } catch (error) {
        const failure = hsError(error);
        if (failure.status !== 409) 
            return { ok: false, state: 'failed', message: describe(failure) };

        try {
            //check existing
            await axios.get(
                `${HUBSPOT_PROPERTIES_API}/${objectType}/groups/${GROUP_NAME}`,
                authHeaders(accessToken)
            );
            return { ok: true, state: 'existing' };
        } catch (verifyError) {
            return { ok: false, state: 'failed', message: describe(hsError(verifyError)) };
        }
    }
}

/**
 * Create one property and then prove it is really there. The POST alone is
 * not evidence - only a successful read-back of a non-archived property is.
 */
async function ensureProperty(objectType, [name, label], accessToken) {
    let created = false;

    try {
        await axios.post(
            `${HUBSPOT_PROPERTIES_API}/${objectType}`,
            { name, label, groupName: GROUP_NAME, type: 'string', fieldType: 'text' },
            authHeaders(accessToken)
        );
        created = true;
    } catch (error) {
        const failure = hsError(error);
        // Anything other than a name conflict is a real failure - do not guess.
        if (failure.status !== 409) {
            return { name, ok: false, state: 'failed', message: describe(failure) };
        }
    }

    const live = await fetchProperty(objectType, name, accessToken, false);
    if (live.error) {
        return { name, ok: false, state: 'unverified', message: `could not read the property back - ${describe(live.error)}` };
    }
    if (live.property && !live.property.archived) {
        return {
            name,
            ok: true,
            state: created ? 'created' : 'existing',
            message: `in group "${live.property.groupName}"`
        };
    }

    return {
        name,
        ok: false,
        state: 'missing',
        message: `HubSpot accepted the request but the property cannot be read back on ${objectType}`
    };
}

/**
 * Create the Sales Activity Tracking group and its properties on contacts
 * and companies. Called after the OAuth token exchange.
 * Never throws - returns { ok, errors, summary } so the install can continue
 * either way, but ok is now only true when every property was verified.
 */
async function createAllProperties(accessToken) {
    const errors = [];
    const summary = [];

    if (!accessToken) {
        const message = 'no access token was passed to createAllProperties';
        console.log(`\n[Properties] ERROR: ${message}\n`);
        return { ok: false, errors: [message], summary };
    }

    for (const objectType of OBJECT_TYPES) {
        const group = await ensureGroup(objectType, accessToken);

        if (!group.ok) {
            // No group means the properties have nowhere to go - skip this object type.
            const message = `group "${GROUP_NAME}" on ${objectType} - ${group.message}`;
            errors.push(message);
            console.log(`\n[Properties] ERROR: ${message}\n`);
            continue;
        }

        const lines = [];
        for (const property of PROPERTIES) {
            const result = await ensureProperty(objectType, property, accessToken);
            summary.push({ objectType, ...result });
            lines.push(`\t${result.name.padEnd(24)}${result.state.toUpperCase().padEnd(10)}${result.message}`);
            if (!result.ok) 
                errors.push(`${result.name} on ${objectType} - ${result.message}`);
        }

        console.log(
            `\n[Properties] ${objectType} - group "${GROUP_NAME}" ${group.state}\n` + lines.join('\n') + '\n'
        );
    }

    const verified = summary.filter(entry => entry.ok).length;
    console.log(`[Properties] ${verified}/${summary.length} properties verified on HubSpot\n`);

    return { ok: errors.length === 0 && verified === OBJECT_TYPES.length * PROPERTIES.length, errors, summary };
}

module.exports = {
    getProperties,
    createAllProperties
};
