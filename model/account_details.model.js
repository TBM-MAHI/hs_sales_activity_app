const { accountDetailsModel } = require('./account_details.mongo');

/**
 * Create or update the details for one portal, keyed on portalID so a
 * re-install refreshes the row instead of adding a second one.
 * Throws on failure - the caller decides whether that is fatal.
 */
async function upsert_AccountDetails(details) {
    const { portalID, hub_domain, timeZone, accountType, user_email } = details;

    if (!portalID) 
        throw new Error('upsert_AccountDetails: portalID is required');

    const update = { portalID: Number(portalID), hub_domain, timeZone, accountType, user_email };

    // Never overwrite a stored value with undefined - a partial update should
    // leave the fields it does not know about alone.
    Object.keys(update).forEach(key => update[key] === undefined && delete update[key]);

    return accountDetailsModel.findOneAndUpdate(
        { portalID: Number(portalID) },
        update,
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );
}

async function fetchAccountDetails(portalID) {
    return accountDetailsModel.findOne({ portalID: Number(portalID) });
}

module.exports = {
    upsert_AccountDetails,
    fetchAccountDetails
};
