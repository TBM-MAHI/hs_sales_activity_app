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

// Statuses where the portal still has a live Paddle subscription to change or cancel.
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

function hasLiveSubscription(subscription) {
  return Boolean(subscription.paddleSubscriptionId) && LIVE_STATUSES.includes(subscription.status);
}

/* Scheduled cancel date from a Paddle subscription object, or null. */
function scheduledCancelAt(data) {
  return data?.scheduled_change?.action === 'cancel' ? new Date(data.scheduled_change.effective_at) : null;
}

/**
 * Save a subscription object Paddle returned from our own API call, so the UI
 * is right immediately instead of waiting for the webhook. Stamped with the
 * subscription's updated_at so the matching webhook still applies and older
 * ones do not.
 */
async function saveFromApiResponse(portalId, data) {
  const at = new Date(data.updated_at || Date.now());
  return applyEvent(portalId, at, subscriptionUpdate({ data }));
}

/**
 * Change the plan of an existing subscription in place (no second checkout,
 * so the portal is never billed twice). Prorated and charged/credited now;
 * if the charge fails Paddle keeps the old plan.
 */
async function changePlan(req, res, subscription, plan) {
  const portalId = subscription.portalId;
  if (subscription.plan === plan)
    return res.status(400).json({ error: `Already on the ${plan} plan` });

  // A plan change means they are staying - drop any pending cancellation first.
  if (subscription.scheduledCancelAt)
    await paddleRequest('PATCH', `/subscriptions/${subscription.paddleSubscriptionId}`, { scheduled_change: null });

  const data = await paddleRequest('PATCH', `/subscriptions/${subscription.paddleSubscriptionId}`, {
    items: [{ price_id: PRICE_IDS[plan], quantity: 1 }],
    proration_billing_mode: 'prorated_immediately',
    on_payment_failure: 'prevent_change',
  });

  const saved = await saveFromApiResponse(portalId, data);
  logger.info(`Paddle (${PADDLE.env}) plan change for portal ${portalId}: ${subscription.plan} -> ${plan}, sub ${data.id}`);
  return res.status(200).json({ updated: true, plan: saved?.plan || plan, status: data.status });
}

/**
 * POST /paddle/checkout  body: { plan }
 * No live subscription -> returns { checkoutUrl } for a new Paddle checkout.
 * Live subscription    -> changes its plan in place and returns { updated: true, plan }.
 *
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

    if (hasLiveSubscription(subscription))
      return await changePlan(req, res, subscription, plan);

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
    scheduledCancelAt: scheduledCancelAt(data),
  };
  const plan = planForPriceId(data.items?.[0]?.price?.id);
  if (plan) update.plan = plan;

  // subscription.canceled fires when the cancellation takes effect (end of the
  // paid period, not when the user clicks cancel), so drop to free right then.
  if (data.status === 'canceled') update.plan = DEFAULT_PLAN;
  return update;
}

// The only events that change a portal's plan/status. Subscribe the Paddle
// notification destination to exactly these.
const HANDLED_EVENTS = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.updated', // plan change / resume / scheduled cancel from the portal
  'subscription.past_due',
  'subscription.canceled',
  'transaction.payment_failed',
]);

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
  const tag = `Paddle (${PADDLE.env}) ${event.event_type} ${event.event_id}`;

  // Paddle sends ~12 events per checkout; only these change our data. Everything
  // else gets one short line - unsubscribe from it in Paddle to stop the traffic.
  if (!HANDLED_EVENTS.has(event.event_type)) {
    console.log('[paddleController.js]', `${tag} - ignored`);
    return res.status(200).json({ received: true });
  }

  try {
    let result = null;
    if (event.event_type === 'transaction.payment_failed') {
      // A failed first checkout payment has no subscription yet - nothing to flag.
      if (event.data?.subscription_id) {
        const record = portalId
          ? { portalId }
          : await subscriptionModel.findOne({ paddleSubscriptionId: event.data.subscription_id });
        if (record) result = await applyEvent(record.portalId, occurredAt, { status: 'past_due' });
      }
    } else if (portalId) {
      result = await applyEvent(portalId, occurredAt, subscriptionUpdate(event));
    }

    if (result)
      logger.info(`${tag} - portal ${result.portalId} -> plan ${result.plan}, status ${result.status}, sub ${result.paddleSubscriptionId}`);
    else
      console.log('[paddleController.js]', `${tag} - no change (portal ${portalId || 'missing custom_data.portal_id'}, ${event.data?.id})`);
  } catch (err) {
    console.log('[paddleController.js]', `${tag} - processing failed: ${err.message}`);
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
      remaining: Math.max(limit - subscription.usageCount, 0),
      nextResetDate: subscription.periodEnd,
      currentPeriodEnd: subscription.currentPeriodEnd || null,
      cancelAt: subscription.scheduledCancelAt || null,
      hasPaddleSubscription: Boolean(subscription.paddleSubscriptionId),
    });
  } catch (err) {
    console.log('[paddleController.js]', `plan lookup failed for portal ${portalId}: ${err.message}`);
    return res.status(500).json({ error: 'Could not load plan' });
  }
}

/**
 * GET /paddle/plans?portalId= - everything the upgrade modal needs: the
 * current plan and every plan it can show, flagged with which one is current.
 * Plans are chosen by name ({ plan: 'growth' } to /checkout); price IDs stay
 * on the server.
 */
async function getPlans(req, res) {
  const portalId = req.query.portalId;
  if (!portalId)
    return res.status(400).json({ error: 'Missing portalId' });

  try {
    let subscription = await subscriptionService.getOrCreateByPortalId(portalId);
    subscription = await subscriptionService.resetIfPeriodExpired(subscription);

    return res.status(200).json({
      current: {
        plan: subscription.plan,
        status: subscription.status,
        usageCount: subscription.usageCount,
        limit: subscriptionService.getLimitForPlan(subscription.plan),
        currentPeriodEnd: subscription.currentPeriodEnd || null,
        cancelAt: subscription.scheduledCancelAt || null,
        hasPaddleSubscription: hasLiveSubscription(subscription),
      },
      available: Object.entries(PLANS).map(([plan, { priceUsd }]) => ({
        plan,
        priceUsd,
        limit: subscriptionService.getLimitForPlan(plan),
        isCurrent: plan === subscription.plan,
        // 'free' is not bought - a paid portal gets there by cancelling.
        purchasable: Boolean(PRICE_IDS[plan]),
      })),
    });
  } catch (err) {
    console.log('[paddleController.js]', `plans lookup failed for portal ${portalId}: ${err.message}`);
    return res.status(500).json({ error: 'Could not load plans' });
  }
}

/**
 * POST /paddle/cancel - cancel at the end of the paid period. The portal keeps
 * its plan until then; subscription.canceled drops it to free at that point.
 * The subscription ID comes from our database, never from the request.
 */
async function cancelSubscription(req, res) {
  const portalId = req.query.portalId;
  if (!portalId)
    return res.status(400).json({ error: 'Missing portalId' });

  try {
    const subscription = await subscriptionModel.findOne({ portalId: String(portalId) });
    if (!subscription || !hasLiveSubscription(subscription))
      return res.status(404).json({ error: 'No active paid subscription for this portal' });

    if (subscription.scheduledCancelAt)
      return res.status(200).json({ canceled: true, cancelAt: subscription.scheduledCancelAt, alreadyScheduled: true });

    const data = await paddleRequest('POST', `/subscriptions/${subscription.paddleSubscriptionId}/cancel`, {
      effective_from: 'next_billing_period',
    });
    await saveFromApiResponse(portalId, data);

    const cancelAt = scheduledCancelAt(data);
    logger.info(`Paddle (${PADDLE.env}) cancel scheduled for portal ${portalId}, sub ${data.id}, effective ${cancelAt?.toISOString() || 'now'}`);
    return res.status(200).json({ canceled: true, cancelAt, status: data.status });
  } catch (err) {
    console.log('[paddleController.js]', `cancel failed for portal ${portalId}: ${err.message}`);
    return res.status(err.status || 500).json({ error: err.message || 'Could not cancel subscription' });
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

module.exports = { createCheckout, handleWebhook, getCustomerPortal, getCurrentPlan, getPlans, cancelSubscription, payPage };
