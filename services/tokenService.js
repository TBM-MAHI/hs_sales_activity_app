/* Single place that answers "give me a usable access token for this portal".
   Everything that calls HubSpot on behalf of an installed portal goes through
   here, so the refresh rules live in one file instead of in every caller. 
*/

const axios = require('axios');
const {
    fetchAuthInfo,
    insert_to_UserAuth_Collection,
    accessToken_Validity
} = require('../model/auth.model');

const OAUTH_API = 'https://api.hubapi.com/oauth/2026-03';

// One refresh per portal at a time. Without this, several requests arriving
// together would each spend the same refresh token and race to store the result.
const inFlightRefresh = new Map();

/**
 * Return a valid access token for the portal:
 *   stored token still valid -> use it
 *   stored token expired     -> refresh with the stored refresh token,
 *                               save the new pair, return the new token
 * Throws { status, message } when the portal is unknown or HubSpot refuses.
 */
async function getValidAccessToken(portalID) {
    if (!portalID) 
        throw { status: 400, message: 'portalID is required to look up a HubSpot access token' };

    const authInfo = await fetchAuthInfo(portalID);
    if (!authInfo) 
        throw { status: 401, message: `No tokens stored for portal ${portalID} - install the app on that portal first` };

    if (!accessToken_Validity(authInfo)) 
        return authInfo.access_token;

    return refreshAndStore(portalID, authInfo.refresh_token);
}

/**
 * Exchange the refresh token for a fresh pair and write both back to Mongo.
 * Concurrent callers for the same portal share one refresh.
 */
function refreshAndStore(portalID, refreshToken) {
    const key = String(portalID);

    const pending = inFlightRefresh.get(key);
    if (pending) {
        console.log(`[Token] portal ${portalID} - refresh already in progress, waiting on it`);
        return pending;
    }

    const refresh = doRefresh(portalID, refreshToken)
        .finally(() => inFlightRefresh.delete(key));

    inFlightRefresh.set(key, refresh);
    return refresh;
}

async function doRefresh(portalID, refreshToken) {
    if (!refreshToken) 
        throw { status: 401, message: `No refresh token stored for portal ${portalID} - the app must be re-installed` };

    // Required lazily: hsoAuth_Controller pulls this module in as well, and a
    // top-level require here would hand back a half-built module.
    const { refreshAccessToken } = require('../controllers/hsoAuth_Controller');
    const tokens = await refreshAccessToken(refreshToken);

    // refreshAccessToken never throws - it hands back { message } on failure.
    if (!tokens.access_token) 
        throw { status: 401, message: `HubSpot refused the refresh for portal ${portalID} - ${tokens.message || 'no access_token returned'}` };

    // 2026-03 returns hub_id and scopes on a refresh too.
    const { access_token, refresh_token, expires_in, hub_id, scopes } = tokens;

    // hub_id is authoritative: if HubSpot says this token belongs to a different
    // portal than the row we read, writing it back would corrupt that row.
    if (hub_id && Number(hub_id) !== Number(portalID)) 
        throw { status: 500, message: `Refresh for portal ${portalID} came back for hub_id ${hub_id} - refusing to store it` };

    await insert_to_UserAuth_Collection({
        portalID,
        access_token,
        // HubSpot usually returns the same refresh token, but store whatever it
        // sends so a rotated one is not lost.
        refresh_token: refresh_token || refreshToken,
        expires_in,
        scopes
    });

    console.log(
        `\n[Token] portal ${portalID} - access token refreshed and saved` +
        `\n\taccess_token : ${access_token}` +
        `\n\tscopes       : ${(scopes || []).join(', ') || 'unchanged'}` +
        `\n\texpires_in   : ${expires_in}s\n`
    );

    return access_token;
}

/**
 * Retrieve access token metadata.
 * POST /oauth/2026-03/token/introspect - the 2026-03 
 * only the two fields the app actually stores are pulled out of it.

 * Never throws - returns { error } so a failed lookup cannot break an install.
 */
async function getTokenMetadata(token, tokenTypeHint = 'access_token') {
    try {
        const { data } = await axios.post(
            `${OAUTH_API}/token/introspect`,
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                token_type_hint: tokenTypeHint,
                token
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        if (data.active === false) 
            return { error: 'HubSpot reports this token is no longer active' };

        return {
            hub_id: data.hub_id,
            hub_domain: data.hub_domain,   // stored on account_details
            user_email: data.user          // "user" is the email address
        };
    } catch (err) {
        const body = err.response?.data;
        const reason = body?.message || body?.error_description || body?.error || err.message;
        return { error: body?.correlationId ? `${reason} (correlationId ${body.correlationId})` : reason };
    }
}

module.exports = { getValidAccessToken, getTokenMetadata };
