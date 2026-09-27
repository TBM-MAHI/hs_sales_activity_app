const mongoose = require("mongoose");
const { PLAN_NAMES, DEFAULT_PLAN } = require('../config/planLimits');

/**
 * One document per installed portal: which plan it is on and how many records
 * it has used in the current calendar-month period.
 * Created at install time (oauthCallback) and, as a fallback, on the first
 * workflow action from a portal that has no document yet.
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
    // Billing - not wired up yet.
    lemonSqueezyCustomerId: {
        type: String,
        required: false
    },
    lemonSqueezySubscriptionId: {
        type: String,
        required: false
    },
    status: {
        type: String,
        default: 'active'
    }
}, { timestamps: true }
);

exports.subscriptionModel = mongoose.model('subscriptions', subscriptionSchema);
