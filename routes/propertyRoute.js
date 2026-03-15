const express = require('express');
let api_Router = express.Router();
let propertyController = require('../controllers/propertyController');

let c = 0;

const randomDelay = () => {
    const min = 5000;
    const max = 10000;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log("delay - ",delay);
    return new Promise(resolve => setTimeout(resolve, delay));
};

api_Router.post('/test', async (req, res) => {
    console.log(`calling route-> property/test`);
    return res.status(200).json(req.body);
});


// propertyRoute.js
api_Router.get('/getallprops', async (req, res) => {  
    console.log("logging request body at /getallprops ", req.body);
    await propertyController.getProperties(req, res);
});

module.exports = api_Router;