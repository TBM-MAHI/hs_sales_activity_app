const { authModel } = require('./auth.mongo');

// Refresh this many ms before HubSpot would actually expire the token, so a
// call that starts just under the wire does not expire mid-flight.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Create or update the token record for one portal.
 * The portal id is the unique key, so a re-install simply overwrites the
 * previous tokens instead of creating a second document.
 * Throws on failure - the caller decides whether that is fatal.
 */
let insert_to_UserAuth_Collection = async (accData) => {
    const { portalID, access_token, refresh_token, expires_in, scopes } = accData;

    if (!portalID) 
        throw new Error('insert_to_UserAuth_Collection: portalID is required');

    const update = {
        portalID: Number(portalID),
        refresh_token,
        access_token,
        expires_in: Number(expires_in),
        scopes,
        token_timestamp: Date.now()
    };

    // A refresh does not always resend scopes - dropping the empty keys keeps
    // the values the install already stored instead of blanking them.
    Object.keys(update).forEach(key => update[key] === undefined && delete update[key]);

    const updatedAuth = await authModel.findOneAndUpdate(
        { portalID: Number(portalID) },
        update,
        {
            new: true,           // return the document as it is after the write
            upsert: true,        // insert it when this portal is not stored yet
            setDefaultsOnInsert: true,
            runValidators: true
        }
    );

    return updatedAuth;
};

/**
 * Read the stored tokens for one portal.
 * Returns null when the portal has never installed the app - that is an
 * answer, not an error, so callers can tell it apart from a database failure.
 */
async function fetchAuthInfo(portalID) {
    return authModel.findOne({ portalID: Number(portalID) });
}

/**
 * True when the stored access token is expired (or close enough to it).
 * Pure - it reads only the record it is given, so two portals can never
 * overwrite each other's answer.
 */
function accessToken_Validity(authInfo, safetyMarginMs = TOKEN_REFRESH_MARGIN_MS) {
    const token_age = Date.now() - authInfo.token_timestamp;
    const token_lifetime = Number(authInfo.expires_in) * 1000;
    const access_token_expired = token_age >= token_lifetime - safetyMarginMs;

    console.log('[auth.model.js]',
        `[Token] portal ${authInfo.portalID} - age ${Math.round(token_age / 1000)}s of ${Math.round(token_lifetime / 1000)}s lifetime` +
        ` - ${access_token_expired ? 'EXPIRED, refreshing' : 'still valid'}`
    );

    return access_token_expired;
}

module.exports = {
    insert_to_UserAuth_Collection,
    fetchAuthInfo,
    accessToken_Validity,
    TOKEN_REFRESH_MARGIN_MS
};
