const express = require('express');
const router = express.Router();
const hubspotController = require('../controllers/hubspotController');

router.get('/lead', hubspotController.oauthCallback);
router.get('/', hubspotController.install);
router.get('/error', hubspotController.error);


module.exports = router;
