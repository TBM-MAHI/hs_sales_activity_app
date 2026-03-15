const mongoose = require("mongoose");

let authSchema = new mongoose.Schema({
    portalID: {
        type: Number,
        required: true
    },
    refresh_token: {
        type: String,
        required: true
    },
    access_token: {
        type: String,
        required: true
    },
    expires_in: {
        type: Number,
        required: true
    },
    hub_domain: {
        type: String,
        required: false
    },
    token_timestamp: {
        type: Number,
        required: true
    }
}, { timestamps: true }
);

exports.authModel = mongoose.model('account_Auth', authSchema);