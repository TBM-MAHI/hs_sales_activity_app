const axios = require('axios');
const logger = require('../utils/logger');

const getProperties = async (req, res) => {
    try {
        // Get objectType from query parameters (default to 'contacts')
        const objectType = req.query.objectType || 'contacts';
        // Get access token
       // const accessToken = await getAccessToken(req);
        const accessToken = process.env.TEMP_TEST_API_KEY; // Use API key for testing if OAuth is not set up
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
        console.log(properties);
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
            // Other error
            return res.status(500).json({
                error: 'Internal server error'
            });
        }
    }
};

const HUBSPOT_PROPERTIES_API = 'https://api.hubapi.com/crm/v3/properties';
const OBJECT_TYPES = ['contacts', 'companies'];
const GROUP_NAME = 'sales_activity_tracking';

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

/**
 * POST to HubSpot, treating "already exists" (409) as a non-error.
 * Returns true if something was created, false if it already existed.
 */
async function createOrSkip(url, body, accessToken, description) {
    try {
        await axios.post(url, body, authHeaders(accessToken));
        return true;
    } catch (error) {
        const { status, data } = error.response || {};
        if (status === 409 || /already exists/i.test(data?.message || '')) {
            logger.info(`${description} already exists — skipped`);
            return false;
        }
        throw new Error(`${description}: ${data?.message || error.message}`);
    }
}

/**
 * Create the Sales Activity Tracking group and its properties on contacts
 * and companies. Called once after the OAuth token exchange.
 * Never throws — returns { ok, errors } so the install can continue either way.
 */
async function createAllProperties(accessToken) {
    const errors = [];

    for (const objectType of OBJECT_TYPES) {
        const base = `${HUBSPOT_PROPERTIES_API}/${objectType}`;
        try {
            await createOrSkip(
                `${base}/groups`,
                { name: GROUP_NAME, label: 'Sales Activity Tracking', displayOrder: -1 },
                accessToken,
                `Group ${GROUP_NAME} on ${objectType}`
            );
        } catch (error) {
            // No group means the properties have nowhere to go — skip this object type.
            errors.push(error.message);
            continue;
        }

        for (const [name, label] of PROPERTIES) {
            try {
                await createOrSkip(
                    base,
                    { name, label, groupName: GROUP_NAME, type: 'string', fieldType: 'text' },
                    accessToken,
                    `Property ${name} on ${objectType}`
                );
            } catch (error) {
                errors.push(error.message);
            }
        }
    }

    if (errors.length) logger.error(`Property setup failed: ${errors.join('; ')}`);
    else logger.info(`All properties ready on ${OBJECT_TYPES.join(' and ')}`);

    return { ok: errors.length === 0, errors };
}

module.exports = {
    getProperties,
    createAllProperties
};
