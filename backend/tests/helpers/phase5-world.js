import mongoose from "mongoose";
import * as models from "../../src/site/models/index.js";
import { readConfig } from "../../src/config.js";
import { buildSeedData } from "../../src/site/seed/data.js";
import { validateSeedData } from "../../src/site/seed/seed.js";

export const TEST_DATABASE = "MatchDay_phase5_test";
const collections = {
    users: "User",
    matches: "Match",
    bookings: "Booking",
    waitlist: "Waitlist",
    outbox: "Outbox",
    config: "Config",
};

export async function preparePhase5World() {
    if (process.env.PHASE5_TEST_RESET !== TEST_DATABASE)
        throw new Error(`Reset refused: explicitly set PHASE5_TEST_RESET=${TEST_DATABASE}.`);
    const config = readConfig(process.env, { requireStudent: true });
    const data = buildSeedData(config.STUDENT_EMAIL.toLowerCase().trim());
    await validateSeedData(data);
    await mongoose.connect(process.env.MONGODB_URI, {
        dbName: TEST_DATABASE,
        autoCreate: false,
        autoIndex: false,
        serverSelectionTimeoutMS: 10000,
    });
    if (mongoose.connection.name !== TEST_DATABASE)
        throw new Error("Database mismatch. No reset performed.");
    for (const name of Object.values(collections)) {
        await models[name].createCollection();
        await models[name].createIndexes();
    }
    await mongoose.connection.transaction(async (session) => {
        for (const [collection, name] of Object.entries(collections)) {
            await models[name].deleteMany({}, { session });
            if (data[collection].length)
                await models[name].insertMany(data[collection], { session });
        }
    });
    return data;
}

export async function siteRecords() {
    const result = {};
    for (const [collection, name] of Object.entries(collections))
        result[collection] = await models[name].find({}).sort({ _id: 1 }).lean();
    return JSON.stringify(result);
}
