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

module.exports = {
    getProperties
};