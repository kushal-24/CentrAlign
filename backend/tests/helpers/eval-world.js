import mongoose from "mongoose";
import * as models from "../../src/site/models/index.js";
import { buildSeedData } from "../../src/site/seed/data.js";
import { validateSeedData, RESET_COLLECTIONS } from "../../src/site/seed/seed.js";
import { siteRecords } from "./phase5-world.js";

// Evaluation-only setup; never change the application's DB_NAME.
export const EVALUATION_DATABASE = "MatchDay_phase9_eval";
const modelNames = {
    users: "User",
    matches: "Match",
    bookings: "Booking",
    waitlist: "Waitlist",
    outbox: "Outbox",
    config: "Config",
};

export function requireEvaluationDatabase(confirmation, connection = null) {
    if (
        confirmation !== EVALUATION_DATABASE ||
        (connection &&
            (connection !== mongoose.connection || connection.name !== EVALUATION_DATABASE))
    ) {
        throw new Error(`Reset refused: explicitly pass --confirm-reset ${EVALUATION_DATABASE}.`);
    }
}

export async function resetEvaluationWorld(confirmation, email) {
    requireEvaluationDatabase(confirmation, mongoose.connection);
    const data = buildSeedData(email.toLowerCase().trim());
    await validateSeedData(data);
    for (const Model of Object.values(models)) {
        await Model.createCollection();
        await Model.createIndexes();
    }
    await mongoose.connection.transaction(async (session) => {
        for (const collection of RESET_COLLECTIONS) {
            const Model = models[modelNames[collection]];
            await Model.deleteMany({}, { session });
            if (data[collection].length) await Model.insertMany(data[collection], { session });
        }
        await models.AgentRun.deleteMany({}, { session });
    });
    return JSON.parse(await siteRecords());
}

export async function readEvaluationWorld() {
    requireEvaluationDatabase(EVALUATION_DATABASE, mongoose.connection);
    return JSON.parse(await siteRecords());
}
