import mongoose from "mongoose";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readConfig } from "../../config.js";
import { DB_NAME } from "../../constants.js";
import * as models from "../models/index.js";
import { buildSeedData, SEED_NOW } from "./data.js";

export const RESET_COLLECTIONS = Object.freeze([
    "users",
    "matches",
    "bookings",
    "waitlist",
    "outbox",
    "config",
]);
const modelNames = {
    users: "User",
    matches: "Match",
    bookings: "Booking",
    waitlist: "Waitlist",
    outbox: "Outbox",
    config: "Config",
};

export async function validateSeedData(data) {
    for (const collection of RESET_COLLECTIONS) {
        for (const record of data[collection])
            await new models[modelNames[collection]](record).validate();
    }
    const emails = data.users.map((user) => user.email.toLowerCase().trim());
    if (new Set(emails).size !== emails.length) throw new Error("Seed user emails must be unique");
}

export async function resetDemo(connection, data, confirmedDatabase) {
    if (
        confirmedDatabase !== DB_NAME ||
        connection.name !== DB_NAME ||
        connection !== mongoose.connection
    ) {
        throw new Error("Seed reset requires confirmation of the configured database name");
    }
    await validateSeedData(data);
    for (const Model of Object.values(models)) {
        await Model.createCollection();
        await Model.createIndexes();
    }
    const session = await connection.startSession();
    try {
        await session.withTransaction(async () => {
            for (const collection of RESET_COLLECTIONS) {
                const Model = models[modelNames[collection]];
                await Model.deleteMany({}, { session });
                if (data[collection].length) await Model.insertMany(data[collection], { session });
            }
        });
    } finally {
        await session.endSession();
    }
    return Object.fromEntries(RESET_COLLECTIONS.map((name) => [name, data[name].length]));
}

async function main() {
    const config = readConfig(process.env, { requireStudent: true });
    const data = buildSeedData(config.STUDENT_EMAIL);
    await validateSeedData(data);
    const args = process.argv.slice(2);
    const counts = Object.fromEntries(RESET_COLLECTIONS.map((name) => [name, data[name].length]));
    if (args.length === 1 && args[0] === "--dry-run") {
        process.stdout.write(
            `${JSON.stringify({ database: DB_NAME, seedNow: SEED_NOW, resetCollections: RESET_COLLECTIONS, records: counts, preserves: ["agent_runs", "all other collections"] }, null, 2)}\n`,
        );
        return;
    }
    if (args.length !== 2 || args[0] !== "--confirm-reset" || args[1] !== DB_NAME) {
        throw new Error(
            `No database changes made. Review with --dry-run, then explicitly pass --confirm-reset ${DB_NAME}.`,
        );
    }
    if (["admin", "local", "config"].includes(DB_NAME))
        throw new Error("Cannot seed a MongoDB system database");
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            dbName: DB_NAME,
            autoCreate: false,
            autoIndex: false,
        });
        const result = await resetDemo(mongoose.connection, data, args[1]);
        process.stdout.write(`Seeded ${DB_NAME} at ${SEED_NOW}: ${JSON.stringify(result)}\n`);
    } finally {
        await mongoose.disconnect();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await main();
    } catch (error) {
        const message =
            error.message.startsWith("No database changes made.") ||
            error.message.startsWith("Missing configuration:")
                ? error.message
                : "Seed failed. Check configuration, data validation, and transaction-capable MongoDB access. Database reset and inserts are transactional.";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
