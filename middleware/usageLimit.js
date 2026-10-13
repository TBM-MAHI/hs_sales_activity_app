const logger = require('../utils/logger');
const subscriptionService = require('../services/subscriptionService');

/**
 * Quota gate for workflow actions - runs before any HubSpot call, including
 * the token refresh. Usage is NOT counted here: activityController increments
 * only after HubSpot accepted the property update, so failed runs are free.
 *
 * portalId is origin.portalId - object.objectId is the CRM record, not the portal.
 */
async function checkUsageLimit(req, res, next) {
  const portalId = req.body?.origin?.portalId || req.body?.portalId;
  if (!portalId)
    return res.status(400).json({ updateSuccess: false, errorMessage: 'Missing origin.portalId - cannot resolve an access token' });

  try {
    // getOrCreate is the fallback for portals installed before subscriptions
    // existed - a portal with no document is a free-plan portal.
    let subscription = await subscriptionService.getOrCreateByPortalId(portalId);
    subscription = await subscriptionService.resetIfPeriodExpired(subscription);

    if (!subscriptionService.isWithinLimit(subscription)) {
      const limit = subscriptionService.getLimitForPlan(subscription.plan);
      logger.info(`Quota exceeded for portal ${portalId} - plan ${subscription.plan}, ${subscription.usageCount}/${limit}`);

      /* 400 so the enrollment shows as an error in the workflow history.
         HubSpot retries custom-action calls that fail with 5xx/429 only; other
         4xx are a permanent failure, so a blocked portal does not loop. Never
         change this to 429 or 5xx - those are retried. */
      return res.status(400).json({
        status: 'quota_exceeded',
        error: 'Usage limit exceeded',
        updateSuccess: false,
        plan: subscription.plan,
        usageCount: subscription.usageCount,
        currentUsage: subscription.usageCount,
        limit,
        upgradeUrl: '/paddle/checkout',
        errorMessage: `Monthly limit of ${limit} records reached on the ${subscription.plan} plan. Upgrade your plan to keep processing records this month.`
      });
    }

    req.subscription = subscription;
    next();
  } catch (err) {
    console.log('[usageLimit.js]', `quota check failed for portal ${portalId}: ${err.message}`);
    return res.status(500).json({ updateSuccess: false, errorMessage: 'Could not check usage limit' });
  }
}

module.exports = { checkUsageLimit };
