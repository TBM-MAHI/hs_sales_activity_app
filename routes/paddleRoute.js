const express = require('express');
const router = express.Router();
const paddleController = require('../controllers/paddleController');
const { validateHubSpotSignature } = require('../utils/hubspotSignature');

// Paddle -> us. Authenticated by Paddle-Signature, not HubSpot. The raw body
// parser for this path is mounted in server.js ahead of express.json().
router.post('/webhook', paddleController.handleWebhook);

// Default payment link - opened in the buyer's browser, no auth.
router.get('/pay', paddleController.payPage);

// Settings page UI extension (hubspot.fetch) - signed by HubSpot, so the
// portalId query param can only be the viewer's own portal.
router.post('/checkout', validateHubSpotSignature, paddleController.createCheckout);
router.get('/portal', validateHubSpotSignature, paddleController.getCustomerPortal);
router.get('/plan', validateHubSpotSignature, paddleController.getCurrentPlan);
router.get('/plans', validateHubSpotSignature, paddleController.getPlans);
router.post('/cancel', validateHubSpotSignature, paddleController.cancelSubscription);

module.exports = router;
