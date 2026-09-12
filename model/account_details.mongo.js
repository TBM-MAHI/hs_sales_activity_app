const mongoose = require("mongoose");

/**
 * Everything about the installed account that is not a credential.
 * Kept apart from account_Auth_info so the token document stays small and is
 * only rewritten when the tokens themselves change.
 *
 * hub_domain and user_email come from POST /oauth/2026-03/token/introspect.
 * timeZone and accountType come from GET /account-info/v3/details.
 */
let accountDetailsSchema = new mongoose.Schema({
    portalID: {
        type: Number,
        required: true,
        unique: true
    },
    hub_domain: {
        type: String,
        required: false
    },
    timeZone: {
        type: String,
        required: false
    },
    accountType: {
        type: String,
        required: false
    },
    user_email: {
        type: String,
        required: false
    }
}, { timestamps: true }
);

exports.accountDetailsModel = mongoose.model('account_details', accountDetailsSchema);
