require('dotenv').config();
const express = require('express');
const cors = require('cors');
const hubspot_oAuthRoutes = require('./routes/oAuthRoutes');
const activityRoutes = require('./routes/activityRoute');
const accountRoutes = require('./routes/accountRoute');
const paddleRoutes = require('./routes/paddleRoute');
let { ConnectDB } = require("./utils/mongo.connection");
const session = require('express-session');
const logger = require('./utils/logger'); // Add logger

const app = express();
const PORT = process.env.PORT || 3600;


// Paddle signs the exact bytes it sent - keep the webhook body a raw Buffer.
// Must come before express.json(), which then skips the already-read body.
app.use('/paddle/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
// Use CORS middleware
app.use(cors());
app.use(session({
    secret: Math.random().toString(36).substring(2),
    resave: false,
    saveUninitialized: true
}));

app.use('/oauth', hubspot_oAuthRoutes);
app.use('/activity', activityRoutes);
app.use('/account', accountRoutes);
app.use('/paddle', paddleRoutes);

async function loadDatabaseConnection() {
    await ConnectDB();
    app.listen(PORT, () => logger.info(`Server is running on port ${PORT}`));
}

loadDatabaseConnection();
