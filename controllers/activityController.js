// controllers/activity.controller.js
const logger = require('../utils/logger');
const activityService = require('../services/activityService');
const { getValidAccessToken } = require('../services/tokenService');

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
  if (!['last', 'first', 'most'].includes(activity_timeline)) 
    return res.status(400).json({ updateSuccess: false, errorMessage: 'activity_timeline must be last/first/most' });
  
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

    const timeline = activity_timeline.toLowerCase();
    let activityTypeResult;
    
    if (timeline === 'last') 
      activityTypeResult = await activityService.getLastActivityType(objectId, objectType, ctx);
    
    else 
      activityTypeResult = await activityService.getMostFrequentActivityType(objectId, objectType, ctx);
    

    if (!activityTypeResult) {
      return res.status(200).json({  updateSuccess: false, errorMessage: "Requested activity type was not found" });
    }

   await activityService.updateProperty(objectType, objectId, target_property_2, activityTypeResult, ctx);

    logger.info(`Updated ${objectType} - ${objectId} - ${target_property_2} = ${activityTypeResult}`);
    return res.status(200).json({ activityTypeResult, updateSuccess: true });

  } catch (err) {
    console.log(err);
   // logger.error(`Workflow error: ${err.message}`);
    return res.status(
      err.status || 500).json({ activityTypeValue: null, updateSuccess: false, errorMessage: err.message }
        
      );
  }
}

module.exports = { handleActionInput };
