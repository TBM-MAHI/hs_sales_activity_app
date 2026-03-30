// controllers/activity.controller.js
const logger = require('../utils/logger');
const activityService = require('../services/activityService');

async function handleActionInput(req, res) {
  const { objectId, objectType } = req.body?.object || {};
  const { activity_timeline, target_property } = req.body?.fields || {};

  // Validation
  if (!objectId || !objectType) {
    return res.status(400).json(
      { updateSuccess: false, errorMessage: 'Missing objectId/objectType' }
    );
  }
  if (!['last', 'first', 'most'].includes(activity_timeline)) {
    return res.status(400).json({ updateSuccess: false, errorMessage: 'activity_timeline must be last/first/most' });
  }
  if (!target_property?.trim()) {
    return res.status(400).json({ updateSuccess: false, errorMessage: 'Missing target_property' });
  }
  return res.status(200).json({ 
    updateSuccess: true, errorMessage: null, message : 'Validation passed' 
  });

 /* try {
    await activityService.verifyObjectExists(objectType, objectId);

    const timeline = activity_timeline.toLowerCase();
    let activityTypeValue;
    
    if (timeline === 'last') {
      activityTypeValue = await activityService.getLastActivityType(objectId, objectType);
    } else if (timeline === 'first') {
      activityTypeValue = await activityService.getFirstActivityType(objectId, objectType);
    } else {
      activityTypeValue = await activityService.getMostFrequentActivityType(objectId, objectType);
    }

    if (!activityTypeValue) {
      return res.status(200).json({ activityTypeValue: null, updateSuccess: false, errorMessage: null });
    }

    await activityService.updateProperty(objectType, objectId, target_property, activityTypeValue);

    logger.info(`Updated ${objectType}/${objectId} ${target_property}=${activityTypeValue}`);
    return res.status(200).json({ activityTypeValue, updateSuccess: true, errorMessage: null });

  } catch (err) {
    logger.error(`Workflow error: ${err.message}`);
    return res.status(err.status || 500).json({ activityTypeValue: null, updateSuccess: false, errorMessage: err.message });
  }*/
}

module.exports = { handleActionInput };
