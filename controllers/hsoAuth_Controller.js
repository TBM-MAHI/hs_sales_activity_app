const axios = require('axios');
const { createAllProperties } = require('./propertyController');
const { insert_to_UserAuth_Collection } = require('../model/auth.model');
const { upsert_AccountDetails } = require('../model/account_details.model');
const { getTokenMetadata } = require('../services/tokenService');

// https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
const OAUTH_API = 'https://api.hubapi.com/oauth/2026-03';

// Breather between the property-creation burst and the introspect call, so the
// install does not walk into HubSpot's rate limit on its last step.
const ACCOUNT_DETAILS_DELAY_MS = 1000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
//const REDIRECT_URI = 'http://localhost:3600/oauth/callback';
const REDIRECT_URI = 'https://hs-sales-app-2026.onrender.com/oauth/callback';
// controllers/oauth.controller.js

const SCOPES_LIST = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.schemas.contacts.read',
  'crm.schemas.contacts.write',
  'crm.schemas.companies.read',
  'crm.schemas.companies.write',
  // Required by the emails search - without it /objects/emails/search 403s.
  'sales-email-read',
];
const SCOPES = SCOPES_LIST.join(' ');

/**
 * 2026-03 answers a failure with both the standard OAuth pair
 * (error / error_description) and HubSpot's own (status / message /
 * correlationId). Read the most specific one available and keep the
 * correlationId - it is what HubSpot support asks for.
 */
function oauthError(err) {
  const data = err.response?.data;
  if (!data) return err.message;

  const reason = data.message || data.error_description || data.error || err.message;
  return data.correlationId ? `${reason} (correlationId ${data.correlationId})` : reason;
}

// Exchange authorization code for tokens
async function exchangeForTokens(authCodeProof) {
  try {
    // Every parameter goes in the form-encoded body - 2026-03 rejects secrets
    // passed as query parameters.
    const response = await axios.post(
      `${OAUTH_API}/token`,
      new URLSearchParams(authCodeProof),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.data;
  } catch (err) {
    return { message: oauthError(err) };
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
      `${OAUTH_API}/token`,
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
    return { message: oauthError(err) };
  }
}

/**
 * Invalidate a refresh token - replaces the v1
 * DELETE /oauth/v1/refresh-tokens/{token}, which is now a POST with the token
 * in the body.
 */
async function revokeRefreshToken(refreshToken) {
  try {
    await axios.post(
      `${OAUTH_API}/token/revoke`,
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        token: refreshToken,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return { revoked: true };
  } catch (err) {
    return { revoked: false, message: oauthError(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// ROUTE HANDLERS
// ─────────────────────────────────────────────────────────────

function install(req, res) {
  const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}`;

  console.log('[hsoAuth_Controller.js]',
    `\n[OAuth] Install started - redirecting user to the HubSpot consent screen` +
    `\n\tclient_id     : ${CLIENT_ID}` +
    `\n\tclient_secret : ${CLIENT_SECRET}` +
    `\n\tredirect_uri  : ${REDIRECT_URI}\n`
  );

  if (!CLIENT_ID || !CLIENT_SECRET) 
    console.log('[hsoAuth_Controller.js]', '[OAuth] WARNING: CLIENT_ID / CLIENT_SECRET missing from .env - HubSpot will reject this install\n');
  
  res.redirect(authUrl);
}

async function oauthCallback(req, res) {
  if (!req.query.code) {
    console.log('[hsoAuth_Controller.js]', '\n[OAuth] WARNING: callback arrived with no ?code - sending user to the error page\n');
    return res.redirect('/oauth/error?msg=No%20code%20provided');
  }

  if (req.session?.oauthCode === req.query.code) {
    console.log('[hsoAuth_Controller.js]', `\n[OAuth] Duplicate callback for an already-redeemed code - replaying success page (portal ${req.session.portalId})\n`);
    return res.send(`
      <h2>✅ App Installed Successfully!</h2>
      <p>Portal ID: ${req.session.portalId || 'unknown'}</p>
      <p>You can close this window.</p>
    `);
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
    console.log('[hsoAuth_Controller.js]',
      `\n[OAuth] ERROR: HubSpot refused the token exchange` +
      `\n\treason            : ${tokens.message}` +
      `\n\tredirect_uri sent : ${REDIRECT_URI}` +
      `\n\thint              : this URI must exactly match the redirect URL on the HubSpot app\n`
    );
    return res.redirect(`/oauth/error?msg=${encodeURIComponent(tokens.message)}`);
  }

  // 2026-03 also hands back hub_id and the granted scopes, so the portal is
  // known straight from the token exchange.
  const { access_token, refresh_token, expires_in, hub_id, scopes, token_type } = tokens;
  const expiresAt = new Date(Date.now() + Number(expires_in || 0) * 1000);

  // First and only time we see these values in full - log them for debugging.
  console.log('[hsoAuth_Controller.js]',
    `\n[OAuth] Tokens received from HubSpot` +
    `\n\taccess_token  : ${access_token}` +
    `\n\trefresh_token : ${refresh_token}` +
    `\n\ttoken_type    : ${token_type}` +
    `\n\thub_id        : ${hub_id}` +
    `\n\tscopes        : ${(scopes || []).join(', ') || 'none returned'}` +
    `\n\texpires_in    : ${expires_in}s (expires at ${expiresAt.toISOString()})\n`
  );

  if (req.session) {
    req.session.oauthCode = req.query.code;
  }

  // Get account info
  const accInfo = await getAccountInfo(access_token);
  if (accInfo.error) {
    console.log('[hsoAuth_Controller.js]', `\n[OAuth] ERROR: could not read account info from HubSpot - ${accInfo.error}\n`);
  }

  // hub_id comes from the token exchange itself, so the portal is still known
  // even when the account-info call fails.
  const portalId = hub_id || accInfo.portalId;

  // Store in session if available
  if (req.session) {
    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;
    req.session.portalId = portalId;
  }

  // Provision the custom property group + properties last, once the token is
  // in hand and the portal is known, so a provisioning problem cannot take the
  // install down with it.
  let ok = false;
  try {
    const result = await createAllProperties(access_token);
    ok = result.ok;
    if (!ok) {
      console.log('[hsoAuth_Controller.js]', `\n[OAuth] ERROR: custom property setup failed on portal ${portalId}\n\t${result.errors.join('\n\t')}\n`);
    }
  } catch (propError) {
    // Provisioning must never stop the tokens below from being stored.
    console.log('[hsoAuth_Controller.js]', `\n[OAuth] ERROR: custom property setup threw on portal ${portalId}\n\t${propError.message}\n`);
  }

  console.log('[hsoAuth_Controller.js]', `\n[OAuth] App installed on portal ${portalId} - properties ${ok ? 'verified' : 'INCOMPLETE'} - redirecting to the app website\n`);

  /*******************
   Store tokens in database for persistence
  */
 try {
      await insert_to_UserAuth_Collection({
        portalID: portalId,
        access_token,
        refresh_token,
        expires_in,
        scopes
      });

      console.log('[hsoAuth_Controller.js]',
        `\n[OAuth] Tokens saved to MongoDB` +
        `\n\tportalID   : ${portalId}` +
        `\n\texpires at : ${expiresAt.toISOString()}\n`
      );
    } catch (dbError) {
      // The install itself already succeeded - say so loudly but let the user through.
      console.log('[hsoAuth_Controller.js]',
        `\n[OAuth] ERROR: could not save tokens to MongoDB for portal ${portalId}` +
        `\n\treason : ${dbError.message}` 
      );
    }
  
  res.redirect('https://twinkleflow.com/');

  return saveAccountDetails(portalId, access_token, accInfo)
    .catch(err => console.log('[hsoAuth_Controller.js]', `\n[Account] ERROR: account details step failed for portal ${portalId}\n\t${err.message}\n`));
}

/**
 * Runs after the install response has already been sent: ask HubSpot who this
 * token belongs to and record the account.

 * hub_domain and user_email come from the introspect endpoint; timeZone and
 * accountType from account-info. A failure here is logged and swallowed - the
 * install is already complete and the user must not be held up by it.
 */
async function saveAccountDetails(portalId, accessToken, accInfo) {

  // Space this out from the property calls that just ran.
  await new Promise(resolve => setTimeout(resolve, ACCOUNT_DETAILS_DELAY_MS));

  const metadata = await getTokenMetadata(accessToken, 'access_token');
  if (metadata.error) {
    console.log('[hsoAuth_Controller.js]', `\n[Account] ERROR: token introspection failed for portal ${portalId}\n\t${metadata.error}\n`);
  }

  try {
    await upsert_AccountDetails({
      portalID: portalId,
      hub_domain: metadata.hub_domain,
      user_email: metadata.user_email,
      timeZone: accInfo.timeZone,
      accountType: accInfo.accountType
    });

    console.log('[hsoAuth_Controller.js]',
      `\n[Account] Account details saved to MongoDB` +
      `\n\tportalID    : ${portalId}` +
      `\n\thub_domain  : ${metadata.hub_domain || 'unknown'}` +
      `\n\tuser_email  : ${metadata.user_email || 'unknown'}` +
      `\n\ttimeZone    : ${accInfo.timeZone || 'unknown'}` +
      `\n\taccountType : ${accInfo.accountType || 'unknown'}\n`
    );
  } catch (dbError) {
    console.log('[hsoAuth_Controller.js]', `\n[Account] ERROR: could not save account details for portal ${portalId}\n\t${dbError.message}\n`);
  }
}

function error(req, res) {
  const errorMsg = req.query.msg || 'Unknown error';
  console.log('[hsoAuth_Controller.js]', `\n[OAuth] ERROR: serving the OAuth error page - ${errorMsg}\n`);

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
  revokeRefreshToken,
};
