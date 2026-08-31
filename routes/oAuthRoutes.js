const express = require('express');
const router = express.Router();
const oauthController = require('../controllers/hsoAuth_Controller');

router.get('/install', oauthController.install);
router.get('/callback', oauthController.oauthCallback);
router.get('/error', oauthController.error);

module.exports = router;