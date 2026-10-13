/**
 * Paddle credentials for the active environment. PADDLE_ENV=sandbox selects
 * the sandbox set; anything else is live. Keys from the two environments are
 * not interchangeable (a live key 403s on the sandbox API and vice versa), so
 * everything Paddle-related reads from here and never mixes the two.
 */
const IS_SANDBOX = process.env.PADDLE_ENV === 'sandbox';

const PADDLE = IS_SANDBOX
    ? {
        env: 'sandbox',
        apiBase: 'https://sandbox-api.paddle.com',
        apiKey: process.env.SANDBOX_SERVER_API_KEY,
        webhookSecret: process.env.SANDBOX_WEBHOOK_KEY,
        clientToken: process.env.SANDBOX_CLIENT_TOKEN,
        priceIds: {
            starter: process.env.PADDLE_TEST_PRICE_ID_STARTER,
            growth: process.env.PADDLE_TEST_PRICE_ID_GROWTH,
            unlimited: process.env.PADDLE_TEST_PRICE_ID_UNLIMITED,
        },
    }
    : {
        env: 'live',
        apiBase: 'https://api.paddle.com',
        apiKey: process.env.PADDLE_API_KEY,
        webhookSecret: process.env.PADDLE_WEBHOOK_SECRET,
        clientToken: process.env.PADDLE_CLIENT_TOKEN,
        priceIds: {
            starter: process.env.PADDLE_STARTER_PRICE_ID,
            growth: process.env.PADDLE_GROWTH_PRICE_ID,
            unlimited: process.env.PADDLE_UNLIMITED_PRICE_ID,
        },
    };

// Fail loud at startup rather than on the first customer's checkout.
const missing = ['apiKey', 'webhookSecret']
    .filter(key => !PADDLE[key])
    .concat(Object.keys(PADDLE.priceIds).filter(plan => !PADDLE.priceIds[plan]).map(plan => `priceIds.${plan}`));
if (missing.length)
    console.log('[config/paddle.js]', `Paddle ${PADDLE.env}: missing ${missing.join(', ')} - check .env`);
else
    console.log('[config/paddle.js]', `Paddle environment: ${PADDLE.env}`);

module.exports = { PADDLE };
