// controllers/activity.controller.js
const logger = require('../utils/logger');
const activityService = require('../services/activityService');

async function handleActionInput(req, res) {
  const { objectId, objectType } = req.body?.object || {};
  const { activity_timeline, target_property_2 } = req.body?.fields || {};

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
  
  /* return res.status(200).json({
    outputFields: {
      errorCode: "TARGET_OUTPUT_PROPERTY_MISSING",
      hs_execution_state: "FAIL_CONTINUE"
    }
  });  */

 try {
    await activityService.verifyObjectExists(objectType, objectId); //get the records

    const timeline = activity_timeline.toLowerCase();
    let activityTypeResult;
    
    if (timeline === 'last') {
      activityTypeResult = await activityService.getLastActivityType(objectId, objectType);
    } 
    else {
      activityTypeResult = await activityService.getMostFrequentActivityType(objectId, objectType);
    }

    if (!activityTypeResult) {
      return res.status(200).json({  updateSuccess: false, errorMessage: "Requested activity type was not found" });
    }

   await activityService.updateProperty(objectType, objectId, target_property_2, activityTypeResult);

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
