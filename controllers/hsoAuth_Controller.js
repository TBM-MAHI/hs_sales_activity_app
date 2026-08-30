const axios = require('axios');
const logger = require('../utils/logger');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'https://hs-sales-app-2026.onrender.com/oauth/callback';
// controllers/oauth.controller.js

const SCOPES_LIST = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
  // Add new scopes here
];

const SCOPES = SCOPES_LIST.join(' ');

// Utility function to log with portal ID and email
const logWithDetails = (level, message, req) => {
  const portalId = req.session?.portalId || 'unknown';
  const email = req.session?.email || 'unknown';
  logger.log({ level, message, portalId, email });
};

// Exchange authorization code for tokens
async function exchangeForTokens(authCodeProof) {
  try {
    const response = await axios.post(
      'https://api.hubapi.com/oauth/v1/token',
      new URLSearchParams(authCodeProof),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.data;
  } catch (err) {
    return { message: err.response?.data?.message || err.message };
  }
}

// Get account info from HubSpot
async function getAccountInfo(accessToken) {
  try {
    const response = await axios.get('https://api.hubapi.com/account-info/v3/details', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    return response.data;
  } catch (err) {
    return { error: err.message };
  }
}

// Refresh access token
async function refreshAccessToken(refreshToken) {
  try {
    const response = await axios.post(
      'https://api.hubapi.com/oauth/v1/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.data;
  } catch (err) {
    return { message: err.response?.data?.message || err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// ROUTE HANDLERS
// ─────────────────────────────────────────────────────────────

function install(req, res) {
  const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}`;
  res.redirect(authUrl);
  logWithDetails('info', 'Redirected user to HubSpot OAuth URL for installation', req);
}

async function oauthCallback(req, res) {
  if (!req.query.code) {
    logWithDetails('warn', 'OAuth callback received without a code', req);
    return res.redirect('/oauth/error?msg=No%20code%20provided');
  }

  const authCodeProof = {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    code: req.query.code,
  };

  const tokens = await exchangeForTokens(authCodeProof);

  if (tokens.message) {
    logWithDetails('error', `Error during OAuth callback: ${tokens.message}`, req);
    return res.redirect(`/oauth/error?msg=${encodeURIComponent(tokens.message)}`);
  }

  const { access_token, refresh_token, expires_in } = tokens;

  // Get account info
  const accInfo = await getAccountInfo(access_token);
  console.log('************* logging account information *************');
  console.log(accInfo);

  // Store in session if available
  if (req.session) {
    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;
    req.session.portalId = accInfo.portalId;
  }

  logWithDetails('info', `App successfully installed on portal ${accInfo.portalId}`, req);

  // TODO: Store tokens in database for persistence
  // await saveTokens(accInfo.portalId, access_token, refresh_token, expires_in);

  res.send(`
    <h2>✅ App Installed Successfully!</h2>
    <p>Portal ID: ${accInfo.portalId}</p>
    <p>You can close this window.</p>
  `);
}

function error(req, res) {
  const errorMsg = req.query.msg || 'Unknown error';
  logWithDetails('error', `Displayed error page: ${errorMsg}`, req);

  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <h2>❌ OAuth Error</h2>
    <h4>${errorMsg}</h4>
    <a href="/oauth/install">Try again</a>
  `);
}

module.exports = {
  install,
  oauthCallback,
  error,
  exchangeForTokens,
  getAccountInfo,
  refreshAccessToken,
};