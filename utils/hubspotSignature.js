const crypto = require('crypto');

// https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/fetching-data
// hubspot.fetch signs every request with X-HubSpot-Signature-v3:
// base64(HMAC-SHA256(clientSecret, method + uri + body + timestamp)).
const MAX_AGE_MS = 5 * 60 * 1000;

// v3 signs the URI with these characters decoded.
const DECODE = {
    '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
    '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';'
};

function decodeUri(uri) {
    return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, m => DECODE[m.toUpperCase()]);
}

/**
 * Express middleware: rejects any request that was not signed by HubSpot for
 * this app. Only after this passes can req.query.portalId be trusted.
 */
function validateHubSpotSignature(req, res, next) {
    const signature = req.get('X-HubSpot-Signature-v3');
    const timestamp = req.get('X-HubSpot-Request-Timestamp');

    if (!signature || !timestamp)
        return res.status(401).json({ error: 'Missing HubSpot signature' });

    if (Math.abs(Date.now() - Number(timestamp)) > MAX_AGE_MS)
        return res.status(401).json({ error: 'Stale HubSpot signature' });

    // Render terminates TLS, so rebuild the https URL HubSpot actually called.
    const uri = decodeUri(`https://${req.get('host')}${req.originalUrl}`);
    const body = req.method === 'GET' || !req.body || !Object.keys(req.body).length ? '' : JSON.stringify(req.body);

    const expected = crypto
        .createHmac('sha256', process.env.CLIENT_SECRET)
        .update(`${req.method}${uri}${body}${timestamp}`)
        .digest('base64');

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.log('[hubspotSignature.js]', `Invalid signature for ${req.method} ${uri}`);
        return res.status(401).json({ error: 'Invalid HubSpot signature' });
    }

    next();
}

module.exports = { validateHubSpotSignature };
