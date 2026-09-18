// controllers/activity.controller.js
const logger = require('../utils/logger');
const activityService = require('../services/activityService');
const { getValidAccessToken } = require('../services/tokenService');

/* Every value the action's "activity_timeline" dropdown can send, mapped to the
   service call that answers it. Each takes (objectId, objectType, ctx), so a new
   dropdown option only needs a line here. */
const ACTIVITY_ACTIONS = {
  last: activityService.getLastActivityType,
  most: activityService.getMostFrequentActivityType,
  last_meet_date: activityService.getLastMeetingDate,
  last_call_date: activityService.getLastCallDate,
  last_call_outcome: activityService.getLastCallOutcome,
};

async function handleActionInput(req, res) {
  const { objectId, objectType } = req.body?.object || {};
  const { activity_timeline, target_property_2 } = req.body?.fields || {};
  // HubSpot tells us which portal the workflow ran in.
  const portalId = req.body?.origin?.portalId;

  // Validation
  if (!objectId || !objectType) {
    return res.status(400).json(
      { updateSuccess: false, errorMessage: 'Missing objectId/objectType' }
    );
  }
  const timeline = String(activity_timeline || '').toLowerCase();
  const runAction = ACTIVITY_ACTIONS[timeline];
  if (!runAction) 
    return res.status(400).json({ updateSuccess: false, errorMessage: `activity_timeline must be one of ${Object.keys(ACTIVITY_ACTIONS).join(', ')}` });
  
  if (!target_property_2) 
    return res.status(400).json({ updateSuccess: false, errorMessage: 'Missing target_property_2' });

  if (!portalId) 
    return res.status(400).json({ updateSuccess: false, errorMessage: 'Missing origin.portalId - cannot resolve an access token' });
  
  /* return res.status(200).json({
    outputFields: {
      errorCode: "TARGET_OUTPUT_PROPERTY_MISSING",
      hs_execution_state: "FAIL_CONTINUE"
    }
  });  */

 try {
    // Resolve the portal's token once for this request. Expired tokens are
    // refreshed from the stored refresh token inside tokenService.
    const accessToken = await getValidAccessToken(portalId);
    const ctx = { portalId, accessToken };

    await activityService.verifyObjectExists(objectType, objectId, ctx); //get the records

    // The date/outcome options answer with a single space rather than
    const activityTypeResult = await runAction(objectId, objectType, ctx);

    if (!activityTypeResult) {
      return res.status(200).json({  updateSuccess: false, errorMessage: "Requested activity type was not found" });
    }

   await activityService.updateProperty(objectType, objectId, target_property_2, activityTypeResult, ctx);

    logger.info(`Updated ${objectType} - ${objectId} - ${target_property_2} = ${activityTypeResult}`);
    return res.status(200).json({ activityTypeResult, updateSuccess: true });

  } catch (err) {
    console.log('[activityController.js]', err);
   // logger.error(`Workflow error: ${err.message}`);
    return res.status(
      err.status || 500).json({ activityTypeValue: null, updateSuccess: false, errorMessage: err.message }
        
      );
  }
}

module.exports = { handleActionInput };
