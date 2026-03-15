const logger = require('../utils/logger'); // Add logger
const axios = require('axios');
const qs = require('qs');
let authData = {};
let { insert_to_UserAuth_Collection } = require("../model/auth.model");
const BASE_URL = "http://localhost:3500";

const TokenHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
};

const exchangeForTokens = async (req, exchangeProof) => {
    try {
        const url_encoded_string = qs.stringify(exchangeProof);
        const responseBody = await axios.post('https://api.hubapi.com/oauth/v1/token', url_encoded_string, {
            headers: TokenHeaders
        });
        const tokens = responseBody.data;
        console.log("***************TOKEN*****************");
        console.log(tokens);
        //STORE TO LOCAL OBJECT
        authData.refresh_token = tokens.refresh_token;
        authData.access_token = tokens.access_token;
        authData.expires_in = tokens.expires_in;
        authData.token_timestamp = Date.now();
        //STORE TO SESSION
        req.session.refresh_token = tokens.refresh_token;
        req.session.access_token = tokens.access_token;
        req.session.expires_in = tokens.expires_in;
        req.session.token_timestamp = Date.now();

        logger.info(`Received access token and refresh token for session: ${req.sessionID}`);
        
        return tokens;
    } catch (e) {
        logger.error(`Error exchanging ${exchangeProof.grant_type} for access token: ${e.response ? e.response.data : e.message}`);
        console.log(e);
        return { message: e.response ? e.response.data.message : e.message };
    }
};

const refreshAccessToken = async (req) => {
    const refreshTokenProof = {
        grant_type: 'refresh_token',
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        redirect_uri: BASE_URL + '/lead',
        refresh_token: req.session.refresh_token
    };
    return await exchangeForTokens(req, refreshTokenProof);
};

const getAccessToken = async (req) => {
    console.log("*************logging session ID = DATA from req header from getAccessToken() ");
    const tokenAge = Date.now() - req.session.token_timestamp;
    const tokenLifetime = req.session.expires_in * 1000;
    if (tokenAge >= tokenLifetime) {
        await refreshAccessToken(req);
    }
    return req.session.access_token;
};

const isAuthorized = (req) => {
    return !!req.session.refresh_token;
};

const getContact = async (accessToken) => {
    try {
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };
        const result = await axios.get('https://api.hubapi.com/contacts/v1/lists/all/contacts/all', { headers });
        return result.data[ 0 ];
    } catch (e) {
        logger.error(`Unable to retrieve contact: ${e.message}`);
        return parseErrorResponse(e);
    }
};

const getAccountInfo = async (accessToken) => {
    try {
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };
        const result = await axios.get('https://api.hubapi.com/account-info/v3/details', { headers });
        console.log(result.data);
        
        console.log("MORE INFO............");
        
        const result2 = await axios.get(`https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}`, { headers });
        console.log(result2.data);
        
        authData.portalid = result.data.portalId;
        authData.hub_domain = result2.data.hub_domain;
        //INSERT to MONGO
        await insert_to_UserAuth_Collection(authData);
        
        return result.data;
    } catch (e) {
        logger.error(`Unable to retrieve account info: ${e.message}`);
        return parseErrorResponse(e);
    }
};

const parseErrorResponse = (error) => {
    try {
        return JSON.parse(error.response.body);
    } catch (parseError) {
        logger.error(`Error parsing response: ${parseError.message}`);
        return { status: 'error', message: 'An error occurred', details: error.message };
    }
};

module.exports = {
    exchangeForTokens,
    getAccessToken,
    isAuthorized,
    getContact,
    getAccountInfo,
    BASE_URL
};
