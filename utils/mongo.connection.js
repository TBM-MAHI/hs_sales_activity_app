const mongoose = require("mongoose");
require("dotenv").config();

const MONGO_URL = process.env.MONGO_URL;

mongoose.connection.once("open", () => {
    console.log(`Mongodb Connection is ready..🚀🚀`);
});
mongoose.connection.on("error", (err) => {
    console.error(err);
});

async function ConnectDB() {
    await mongoose.connect(MONGO_URL);
}
async function disconnectDB() {
    await mongoose.disconnect();
}

module.exports = {
    ConnectDB,
    disconnectDB,
};
