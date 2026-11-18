const PLANS = {
    free:      { limit: 50,   priceUsd: 0 },
    starter:   { limit: 500,  priceUsd: 29 },
    growth:    { limit: 2500, priceUsd: 79 },
    // Not enforced (isWithinLimit skips 'unlimited') - a display number so the UI never shows null.
    unlimited: { limit: 100000000, priceUsd: 149 }
};

const PLAN_NAMES = Object.keys(PLANS);
const DEFAULT_PLAN = 'free';
const UNLIMITED_PLAN = 'unlimited';

module.exports = { PLANS, PLAN_NAMES, DEFAULT_PLAN, UNLIMITED_PLAN };
