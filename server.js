require('dotenv').config();
const express = require('express');
const cors = require('cors');
const hubspotRoutes = require('./routes/hubspotRoutes');
const activityRoutes = require('./routes/activityRoute');
let { ConnectDB } = require("./utils/mongo.connection");
const session = require('express-session');
const logger = require('./utils/logger'); // Add logger

const app = express();
const PORT = process.env.PORT || 3600;


app.use(express.json());
// Use CORS middleware
app.use(cors());
app.use(session({
    secret: Math.random().toString(36).substring(2),
    resave: false,
    saveUninitialized: true
}));

app.use('/app', hubspotRoutes);
app.use('/activity', activityRoutes);

async function loadDatabaseConnection() {
   // await ConnectDB();
    app.listen(PORT, () => logger.info(`Server is running on port ${PORT}`));
}

loadDatabaseConnection();
