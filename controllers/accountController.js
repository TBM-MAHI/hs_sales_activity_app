const subscriptionService = require('../services/subscriptionService');
const { fetchAccountDetails } = require('../model/account_details.model');

/**
 * GET /account/info - called by the settings page UI extension via hubspot.fetch.
 * portalId comes from the query string HubSpot appends and signs, so it can
 * only ever be the portal the viewer is in.
 */
async function getAccountInfo(req, res) {
  const portalId = req.query.portalId;
  if (!portalId)
    return res.status(400).json({ error: 'Missing portalId' });

  try {
    let subscription = await subscriptionService.getOrCreateByPortalId(portalId);
    subscription = await subscriptionService.resetIfPeriodExpired(subscription);
    const details = await fetchAccountDetails(portalId);

    // null for unlimited - never Infinity, it serializes to null anyway.
    const limit = subscriptionService.getLimitForPlan(subscription.plan);

    return res.status(200).json({
      portalId: subscription.portalId,
      email: details?.user_email || null,   // the user who installed the app
      domain: details?.hub_domain || null,  // e.g. mycompany.hubspot.com
      plan: subscription.plan,
      status: subscription.status,
      usageCount: subscription.usageCount,
      limit,
      remaining: limit === null ? null : Math.max(limit - subscription.usageCount, 0),
      periodStart: subscription.periodStart,
      nextResetDate: subscription.periodEnd
    });
  } catch (err) {
    console.log('[accountController.js]', `account info failed for portal ${portalId}: ${err.message}`);
    return res.status(500).json({ error: 'Could not load account information' });
  }
}

module.exports = { getAccountInfo };
