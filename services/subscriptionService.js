const { subscriptionModel } = require('../model/subscriptionModel');
const { PLANS, DEFAULT_PLAN, UNLIMITED_PLAN } = require('../config/planLimits');

const DUPLICATE_KEY = 11000;

/* Usage periods are calendar months in UTC: [1st of this month, 1st of next). */
function currentPeriod(now = new Date()) {
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { periodStart, periodEnd };
}

/**
 * Return the portal's subscription, creating a free-tier one if none exists.
 * Two parallel requests can both miss the findOne; the loser of the create
 * hits the unique index and re-reads the winner's document instead.
 */
async function getOrCreateByPortalId(portalId) {
    const id = String(portalId);

    const existing = await subscriptionModel.findOne({ portalId: id });
    if (existing) return existing;

    try {
        return await subscriptionModel.create({
            portalId: id,
            plan: DEFAULT_PLAN,
            usageCount: 0,
            ...currentPeriod()
        });
    } catch (err) {
        if (err.code === DUPLICATE_KEY) {
            return subscriptionModel.findOne({ portalId: id });
        }
        throw err;
    }
}

/**
 * If the stored period has ended, zero usage and roll to the current month.
 * The filter includes the old periodEnd, so when parallel requests all see an
 * expired record only one of them performs the reset; the rest re-read it.
 */
async function resetIfPeriodExpired(record) {
    const now = new Date();
    if (record.periodEnd && now <= record.periodEnd) return record;

    const updated = await subscriptionModel.findOneAndUpdate(
        { portalId: record.portalId, periodEnd: record.periodEnd ?? null },
        { $set: { usageCount: 0, ...currentPeriod(now) } },
        { new: true }
    );

    return updated || subscriptionModel.findOne({ portalId: record.portalId });
}

/* Numeric monthly limit for a plan; null for 'unlimited'. */
function getLimitForPlan(plan) {
    if (plan === UNLIMITED_PLAN) return null;
    return (PLANS[plan] || PLANS[DEFAULT_PLAN]).limit;
}

function isWithinLimit(record) {
    if (record.plan === UNLIMITED_PLAN) return true;
    return record.usageCount < getLimitForPlan(record.plan);
}

/* Atomic +1 - safe under HubSpot firing many enrollments in parallel. */
async function incrementUsage(portalId) {
    return subscriptionModel.findOneAndUpdate(
        { portalId: String(portalId) },
        { $inc: { usageCount: 1 } },
        { new: true }
    );
}

module.exports = {
    getOrCreateByPortalId,
    resetIfPeriodExpired,
    getLimitForPlan,
    isWithinLimit,
    incrementUsage
};
