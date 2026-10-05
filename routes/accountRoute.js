const express = require('express');
const router = express.Router();
const accountController = require('../controllers/accountController');
const { validateHubSpotSignature } = require('../utils/hubspotSignature');

// Settings page UI extension (hubspot.fetch) - signed by HubSpot.
router.get('/info', validateHubSpotSignature, accountController.getAccountInfo);

module.exports = router;
