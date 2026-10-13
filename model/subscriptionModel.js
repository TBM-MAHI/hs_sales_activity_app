const mongoose = require("mongoose");
const { PLAN_NAMES, DEFAULT_PLAN } = require('../config/planLimits');

/**
 * One document per installed portal: which plan it is on and how many records
 * it has used in the current calendar-month period.
 * Created at install time (oauthCallback) and, as a fallback, on the first
 * workflow action from a portal that has no document yet.
 * plan/status are written by the Paddle webhook (controllers/paddleController.js).
 */
let subscriptionSchema = new mongoose.Schema({
    portalId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    plan: {
        type: String,
        enum: PLAN_NAMES,
        default: DEFAULT_PLAN
    },
    usageCount: {
        type: Number,
        default: 0
    },
    periodStart: {
        type: Date
    },
    periodEnd: {
        type: Date
    },
    // active | trialing | past_due | paused | canceled - mirrors Paddle's subscription status.
    status: {
        type: String,
        default: 'active'
    },
    // Billing (Paddle)
    paddleCustomerId: {
        type: String,
        required: false
    },
    paddleSubscriptionId: {
        type: String,
        required: false,
        index: true
    },
    currentPeriodEnd: {
        type: Date
    },
    // occurred_at of the last Paddle event applied - Paddle does not guarantee
    // delivery order, so older events are ignored.
    paddleLastEventAt: {
        type: Date
    }
}, { timestamps: true }
);

exports.subscriptionModel = mongoose.model('subscriptions', subscriptionSchema);
