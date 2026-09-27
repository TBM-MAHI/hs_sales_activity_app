/**
 * Single source of truth for the plan tiers. Import from here - never redefine
 * a limit anywhere else.
 *
 * limit = records processed per calendar month. 'unlimited' has no number:
 * code branches on plan === 'unlimited' instead of comparing against a limit,
 * and null is what gets stored/returned for it (never Infinity - it serializes
 * to null in JSON anyway and cannot be stored meaningfully in MongoDB).
 */
const PLANS = {
    free:      { limit: 50,   priceUsd: 0 },
    starter:   { limit: 500,  priceUsd: 24 },
    growth:    { limit: 2500, priceUsd: 79 },
    unlimited: { limit: null, priceUsd: 149 }
};

const PLAN_NAMES = Object.keys(PLANS);
const DEFAULT_PLAN = 'free';
const UNLIMITED_PLAN = 'unlimited';

module.exports = { PLANS, PLAN_NAMES, DEFAULT_PLAN, UNLIMITED_PLAN };
