const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf } = format;

// Define your custom format
const myFormat = printf(({ level, message, timestamp, portalId, email }) => {
  return `${timestamp} [${level}] : ${message}`;
});

const logger = createLogger({
  level: 'info', // Set your desired log level here
  format: combine(
    timestamp(),
    myFormat
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'app.log' })
  ],
});

module.exports = logger;
