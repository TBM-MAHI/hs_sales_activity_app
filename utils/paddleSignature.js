const crypto = require('crypto');

// https://developer.paddle.com/webhooks/signature-verification
// Paddle-Signature: ts=<unix seconds>;h1=<hex HMAC-SHA256(secret, ts + ':' + rawBody)>
// During a secret rotation Paddle sends more than one h1, so any match passes.
const MAX_AGE_SECONDS = 5 * 60;

/**
 * True when rawBody (the untouched request Buffer) was signed by Paddle with
 * this secret. Never pass a re-serialized req.body - one changed byte fails.
 */
function verifyPaddleWebhook(rawBody, signatureHeader, secret) {
    if (!rawBody || !signatureHeader || !secret) return false;

    let ts = null;
    const h1s = [];
    for (const part of signatureHeader.split(';')) {
        const [key, value] = part.split('=');
        if (key === 'ts') ts = value;
        if (key === 'h1' && value) h1s.push(value);
    }
    if (!ts || !h1s.length) return false;

    // Replay guard - a captured request cannot be re-sent later.
    if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_AGE_SECONDS) return false;

    const expected = Buffer.from(
        crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex')
    );

    // timingSafeEqual throws on a length mismatch, so check that first.
    return h1s.some(h1 => {
        const given = Buffer.from(h1);
        return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}

module.exports = { verifyPaddleWebhook };
