const logger = require('../utils/logger');
const subscriptionService = require('../services/subscriptionService');
const { subscriptionModel } = require('../model/subscriptionModel');
const { verifyPaddleWebhook } = require('../utils/paddleSignature');
const { PLANS, DEFAULT_PLAN } = require('../config/planLimits');

const { PADDLE } = require('../config/paddle');

// Paid plans only - 'free' has no Paddle price. Sandbox or live per PADDLE_ENV.
const PRICE_IDS = PADDLE.priceIds;

function planForPriceId(priceId) {
  return Object.keys(PRICE_IDS).find(plan => PRICE_IDS[plan] && PRICE_IDS[plan] === priceId) || null;
}

async function paddleRequest(method, path, body) {
  const res = await fetch(`${PADDLE.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PADDLE.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log('[paddleController.js]', `${method} ${path} failed: ${res.status} ${JSON.stringify(json.error || json)}`);
    throw { status: 502, message: json.error?.detail || `Paddle API error ${res.status}` };
  }
  return json.data;
}

/**
 * POST /paddle/checkout  body: { plan }
 * Paddle Billing has no "checkout session" object: a checkout is a draft
 * transaction, and data.checkout.url opens it on the default payment link set
 * in Paddle > Checkout > Checkout settings (here: /paddle/pay).
 * portal_id rides in custom_data; Paddle copies it onto the subscription, so
 * every later subscription.* webhook carries it back.
 */
async function createCheckout(req, res) {
  // Signed by HubSpot - see paddleRoute.js. Never taken from the body, or a
  // user could start a checkout against someone else's portal.
  const portalId = req.query.portalId;
  const plan = String(req.body?.plan || '').toLowerCase();

  if (!portalId)
    return res.status(400).json({ error: 'Missing portalId' });
  if (!PRICE_IDS[plan])
    return res.status(400).json({ error: `plan must be one of ${Object.keys(PRICE_IDS).join(', ')}` });

  try {
    const subscription = await subscriptionService.getOrCreateByPortalId(portalId);

    // An existing paid subscription is changed in the customer portal - a
    // second checkout would bill the portal twice.
    if (subscription.paddleSubscriptionId && ['active', 'trialing', 'past_due'].includes(subscription.status))
      return res.status(409).json({ error: 'This portal already has a paid subscription - use the customer portal to change plan', portalUrlEndpoint: '/paddle/portal' });

    const transaction = await paddleRequest('POST', '/transactions', {
      items: [{ price_id: PRICE_IDS[plan], quantity: 1 }],
      custom_data: { portal_id: String(portalId) },
      // Reuse the Paddle customer from an earlier, canceled subscription.
      ...(subscription.paddleCustomerId && { customer_id: subscription.paddleCustomerId }),
    });

    if (!transaction?.checkout?.url)
      return res.status(500).json({ error: 'Paddle returned no checkout URL - set a default payment link in Paddle checkout settings' });

    logger.info(`Paddle (${PADDLE.env}) checkout created for portal ${portalId} - plan ${plan}, transaction ${transaction.id}`);
    return res.status(200).json({ checkoutUrl: transaction.checkout.url, transactionId: transaction.id });
  } catch (err) {
    console.log('[paddleController.js]', `checkout failed for portal ${portalId}: ${err.message}`);
    return res.status(err.status || 500).json({ error: err.message || 'Could not create checkout' });
  }
}

/* Paddle statuses: active | trialing | past_due | paused | canceled. */
function subscriptionUpdate(event) {
  const data = event.data;
  const update = {
    paddleSubscriptionId: data.id,
    paddleCustomerId: data.customer_id,
    status: data.status,
    currentPeriodEnd: data.current_billing_period?.ends_at || null,
  };
  const plan = planForPriceId(data.items?.[0]?.price?.id);
  if (plan) update.plan = plan;

  // subscription.canceled fires when the cancellation takes effect (end of the
  // paid period, not when the user clicks cancel), so drop to free right then.
  if (data.status === 'canceled') update.plan = DEFAULT_PLAN;
  return update;
}

/**
 * Apply a Paddle event to the portal's subscription. The occurred_at filter
 * drops events older than the last one applied - Paddle can deliver out of order.
 */
async function applyEvent(portalId, occurredAt, update) {
  await subscriptionService.getOrCreateByPortalId(portalId);
  const result = await subscriptionModel.findOneAndUpdate(
    {
      portalId: String(portalId),
      $or: [{ paddleLastEventAt: null }, { paddleLastEventAt: { $lte: occurredAt } }],
    },
    { $set: { ...update, paddleLastEventAt: occurredAt } },
    { new: true }
  );
  if (!result) console.log('[paddleController.js]', `Skipped stale event for portal ${portalId} (occurred ${occurredAt.toISOString()})`);
  return result;
}

/**
 * POST /paddle/webhook - req.body is the raw Buffer (server.js mounts
 * express.raw for this path ahead of express.json).
 * Bad signature -> 401. Anything after verification answers 200 even on
 * failure: Paddle retries non-2xx for days, and a bug here would just replay.
 */
async function handleWebhook(req, res) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  if (!verifyPaddleWebhook(rawBody, req.get('Paddle-Signature'), PADDLE.webhookSecret)) {
    console.log('[paddleController.js]', 'Invalid Paddle webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    console.log('[paddleController.js]', `Unparseable webhook body: ${err.message}`);
    return res.status(200).json({ received: true });
  }

  const portalId = event.data?.custom_data?.portal_id;
  const occurredAt = new Date(event.occurred_at || Date.now());
  logger.info(`Paddle (${PADDLE.env}) webhook ${event.event_type} (${event.event_id}) - portal ${portalId || 'unknown'}, ${event.data?.id}`);
  console.log('[paddleController.js]', JSON.stringify(event));

  try {
    switch (event.event_type) {
      case 'subscription.created':
      case 'subscription.activated':
      case 'subscription.updated': // plan change / resume / scheduled cancel from the portal
      case 'subscription.past_due':
      case 'subscription.canceled':
        if (!portalId) {
          console.log('[paddleController.js]', `${event.event_type} ${event.data?.id} has no custom_data.portal_id - not created via /paddle/checkout?`);
          break;
        }
        await applyEvent(portalId, occurredAt, subscriptionUpdate(event));
        break;

      case 'transaction.payment_failed': {
        // A failed first checkout payment has no subscription yet - nothing to flag.
        if (!event.data?.subscription_id) break;
        const record = portalId
          ? { portalId }
          : await subscriptionModel.findOne({ paddleSubscriptionId: event.data.subscription_id });
        if (record) await applyEvent(record.portalId, occurredAt, { status: 'past_due' });
        break;
      }

      default:
        console.log('[paddleController.js]', `Ignoring ${event.event_type}`);
    }
  } catch (err) {
    console.log('[paddleController.js]', `Webhook ${event.event_type} (${event.event_id}) processing failed: ${err.message}`);
  }

  return res.status(200).json({ received: true });
}

/**
 * GET /paddle/portal?portalId=
 * Mints a short-lived Paddle customer portal session (cancel, change card,
 * invoices). Signed-request only: this URL can cancel the subscription.
 */
async function getCustomerPortal(req, res) {
  const portalId = req.query.portalId;
  if (!portalId)
    return res.status(400).json({ error: 'Missing portalId' });

  try {
    const subscription = await subscriptionModel.findOne({ portalId: String(portalId) });
    if (!subscription?.paddleCustomerId)
      return res.status(404).json({ error: 'No paid subscription for this portal', upgradeUrl: '/paddle/checkout' });

    const session = await paddleRequest('POST', `/customers/${subscription.paddleCustomerId}/portal-sessions`, {
      ...(subscription.paddleSubscriptionId && { subscription_ids: [subscription.paddleSubscriptionId] }),
    });

    const sub = session.urls?.subscriptions?.[0];
    return res.status(200).json({
      portalUrl: session.urls?.general?.overview,
      cancelSubscriptionUrl: sub?.cancel_subscription || null,
      updatePaymentMethodUrl: sub?.update_subscription_payment_method || null,
    });
  } catch (err) {
    console.log('[paddleController.js]', `portal session failed for portal ${portalId}: ${err.message}`);
    return res.status(err.status || 500).json({ error: err.message || 'Could not open customer portal' });
  }
}

/* GET /paddle/plan?portalId= - current plan and this month's usage. */
async function getCurrentPlan(req, res) {
  const portalId = req.query.portalId;
  if (!portalId)
    return res.status(400).json({ error: 'Missing portalId' });

  try {
    let subscription = await subscriptionService.getOrCreateByPortalId(portalId);
    subscription = await subscriptionService.resetIfPeriodExpired(subscription);
    const limit = subscriptionService.getLimitForPlan(subscription.plan);

    return res.status(200).json({
      portalId: subscription.portalId,
      plan: subscription.plan,
      status: subscription.status,
      priceUsd: (PLANS[subscription.plan] || PLANS[DEFAULT_PLAN]).priceUsd,
      usageCount: subscription.usageCount,
      limit,
      remaining: limit === null ? null : Math.max(limit - subscription.usageCount, 0),
      nextResetDate: subscription.periodEnd,
      currentPeriodEnd: subscription.currentPeriodEnd || null,
      hasPaddleSubscription: Boolean(subscription.paddleSubscriptionId),
    });
  } catch (err) {
    console.log('[paddleController.js]', `plan lookup failed for portal ${portalId}: ${err.message}`);
    return res.status(500).json({ error: 'Could not load plan' });
  }
}

/**
 * GET /paddle/pay - the default payment link. Paddle sends buyers here with
 * ?_ptxn=txn_...; Paddle.js reads that and opens the checkout overlay.
 * The client-side token is public by design (not the API key).
 */
function payPage(req, res) {
  const token = PADDLE.clientToken;
  if (!token) return res.status(500).send(`Paddle ${PADDLE.env} client token is not set (${PADDLE.env === 'sandbox' ? 'SANDBOX_CLIENT_TOKEN' : 'PADDLE_CLIENT_TOKEN'})`);

  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Checkout</title>
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script></head>
<body style="font-family:sans-serif;text-align:center;padding:48px">
<p id="msg">Loading checkout…</p>
<script>
  ${PADDLE.env === 'sandbox' ? "Paddle.Environment.set('sandbox');" : ''}
  Paddle.Initialize({
    token: ${JSON.stringify(token)},
    eventCallback: function (e) {
      if (e.name === 'checkout.completed') document.getElementById('msg').textContent = 'Payment complete - you can close this tab and return to HubSpot.';
    }
  });
</script></body></html>`);
}

module.exports = { createCheckout, handleWebhook, getCustomerPortal, getCurrentPlan, payPage };
