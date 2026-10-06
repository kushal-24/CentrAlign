import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import mongoose from "mongoose";
import { readConfig } from "../src/config.js";
import { DB_NAME } from "../src/constants.js";
import * as models from "../src/site/models/index.js";
import { buildSeedData } from "../src/site/seed/data.js";
import { resetDemo, RESET_COLLECTIONS } from "../src/site/seed/seed.js";
import { getMatchStatus, getNow, getRefundAmount, parseInstant } from "../src/site/lib/clock.js";
import { app } from "../src/site/server.js";

const truth = JSON.parse(
    await readFile(new URL("../evals/ground_truth.json", import.meta.url), "utf8"),
);
const config = readConfig(process.env, { requireStudent: true });
const args = process.argv.slice(2);
const resetApproved = args.length === 2 && args[0] === "--confirm-reset" && args[1] === DB_NAME;
if (args.length && !resetApproved)
    throw new Error("Provide the exact configured database name to confirm a reset");

let server;
let originalClock;
let clockChanged = false;
let stage = "connect";
try {
    await mongoose.connect(process.env.MONGODB_URI, {
        dbName: DB_NAME,
        autoCreate: false,
        autoIndex: false,
    });
    const connection = mongoose.connection;
    if (connection.name !== DB_NAME) {
        const actual = /^[A-Za-z0-9_-]+$/.test(connection.name)
            ? connection.name
            : "unexpected database name";
        process.stderr.write(
            `Database selection mismatch: expected ${DB_NAME}, connected to ${actual}. No seed records written.\n`,
        );
    }
    assert.equal(connection.name, DB_NAME);
    stage = "inspect existing collections";
    const modelNames = {
        users: "User",
        matches: "Match",
        bookings: "Booking",
        waitlist: "Waitlist",
        outbox: "Outbox",
        config: "Config",
    };
    const snapshot = async () => {
        const result = {};
        for (const collection of RESET_COLLECTIONS)
            result[collection] = await models[modelNames[collection]]
                .find({})
                .sort({ _id: 1 })
                .lean();
        return JSON.stringify(result);
    };
    const otherCollections = (await connection.db.listCollections({}, { nameOnly: true }).toArray())
        .map((item) => item.name)
        .filter((name) => !RESET_COLLECTIONS.includes(name));
    const otherCounts = {};
    for (const collection of otherCollections)
        otherCounts[collection] = await connection.db.collection(collection).countDocuments();
    if (resetApproved) {
        stage = "seed and compare resets";
        const data = buildSeedData(config.STUDENT_EMAIL);
        await resetDemo(connection, data, args[1]);
        const first = await snapshot();
        await resetDemo(connection, data, args[1]);
        assert.equal(await snapshot(), first);
        for (const collection of otherCollections)
            assert.equal(
                await connection.db.collection(collection).countDocuments(),
                otherCounts[collection],
            );
        process.stdout.write(
            "PASS two seeds restore identical records and preserve other collections\n",
        );
    }
    stage = "verify stored data";
    const now = await getNow();
    assert.equal(now.toISOString(), parseInstant(truth.seedNow).toISOString());
    for (const [collection, count] of Object.entries(truth.counts))
        assert.equal(await models[modelNames[collection]].countDocuments(), count);
    const matches = await models.Match.find({}).lean();
    const bookings = await models.Booking.find({}).lean();
    const outbox = await models.Outbox.find({}).lean();
    for (const expected of truth.matches) {
        const match = matches.find((record) => record._id.toString() === expected.id);
        assert.equal(getMatchStatus(match, now), expected.status);
        assert.equal(match.startsAt.toISOString(), expected.startsAt);
        assert.equal(match.endsAt.toISOString(), expected.endsAt);
        assert.equal(match.bookingStatus, expected.bookingStatus);
        assert.equal(match.isFree, expected.isFree);
        assert.equal(match.perBookingLimit, expected.perBookingLimit);
        assert.equal(match.refundFullHoursBefore, expected.refundFullHoursBefore);
        assert.deepEqual(
            match.tiers.map((tier) => ({ ...tier, remaining: tier.capacity - tier.sold })),
            expected.tiers,
        );
        for (const tier of match.tiers) {
            const sold = bookings
                .filter(
                    (booking) =>
                        booking.status === "booked" &&
                        booking.matchId.equals(match._id) &&
                        booking.tier === tier.name,
                )
                .reduce((sum, booking) => sum + booking.quantity, 0);
            assert.equal(tier.sold, sold);
        }
    }
    for (const expected of truth.mainBookings) {
        const booking = bookings.find((record) => record._id.toString() === expected.id);
        const match = matches.find((record) => record._id.equals(booking.matchId));
        assert.equal(booking.code, expected.code);
        assert.equal(booking.userId.toString(), truth.mainUserId);
        assert.equal(booking.quantity, expected.quantity);
        assert.equal(booking.totalPrice, expected.totalPrice);
        assert.equal(getRefundAmount(match, booking, now), expected.refundAtSeedNow);
    }
    for (const booking of bookings) {
        const confirmations = outbox.filter(
            (message) =>
                message.relatedBookingId?.equals(booking._id) &&
                message.type === "booking_confirmation",
        );
        assert.equal(confirmations.length, 1);
        assert.equal(confirmations[0].to, booking.ownerEmail);
        assert.ok(confirmations[0].body.includes(booking.code));
        assert.equal(confirmations[0].createdAt.getTime(), booking.createdAt.getTime());
    }
    const [left, right] = truth.overlaps[0].matchIds.map((id) =>
        matches.find((record) => record._id.toString() === id),
    );
    assert.equal(
        new Date(Math.max(left.startsAt, right.startsAt)).toISOString(),
        truth.overlaps[0].startsAt,
    );
    assert.equal(
        new Date(Math.min(left.endsAt, right.endsAt)).toISOString(),
        truth.overlaps[0].endsAt,
    );
    process.stdout.write(
        "PASS stored counts, ground truth, bookings, inventory, confirmations, refunds, and overlap\n",
    );

    if (resetApproved) {
        stage = "verify clock endpoints";
        originalClock = (await models.Config.findOne({ key: "mockNow" }).lean()).value;
        server = await new Promise((resolve, reject) => {
            const listener = app.listen(0, "127.0.0.1");
            listener.once("listening", () => resolve(listener));
            listener.once("error", reject);
        });
        const url = `http://127.0.0.1:${server.address().port}/admin/clock`;
        const before = await snapshot();
        const initial = await fetch(url);
        assert.equal(initial.status, 200);
        assert.equal((await initial.json()).data.now, now.toISOString());
        const invalid = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: '{"now":"invalid"}',
        });
        assert.equal(invalid.status, 400);
        assert.equal(await snapshot(), before);
        const booking = bookings.find(
            (record) => record._id.toString() === truth.mainBookings[0].id,
        );
        const match = matches.find((record) => record._id.equals(booking.matchId));
        const cases = [
            [parseInstant(truth.mainBookings[0].fullRefundUntil), "upcoming", booking.totalPrice],
            [new Date(Date.parse(truth.mainBookings[0].fullRefundUntil) + 1), "upcoming", 0],
            [match.startsAt, "live", 0],
            [match.endsAt, "past", 0],
        ];
        for (const [instant, status, refund] of cases) {
            clockChanged = true;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ now: instant.toISOString() }),
            });
            assert.equal(response.status, 200);
            const storedNow = await getNow();
            assert.equal(storedNow.getTime(), instant.getTime());
            assert.equal(getMatchStatus(match, storedNow), status);
            assert.equal(getRefundAmount(match, booking, storedNow), refund);
        }
        await models.Config.updateOne(
            { key: "mockNow" },
            { $set: { value: originalClock } },
            { runValidators: true },
        );
        clockChanged = false;
        assert.equal(await snapshot(), before);
        process.stdout.write(
            "PASS real clock endpoints, exact refund/status boundaries, and original clock restoration\n",
        );
    }
} catch (error) {
    const name = /^[A-Za-z0-9_]+$/.test(error.name) ? error.name : "Error";
    const code = /^[A-Za-z0-9_]+$/.test(String(error.code)) ? `, code ${error.code}` : "";
    process.stderr.write(
        `Phase 2 verification failed at ${stage} (${name}${code}). Provider details withheld to protect credentials.\n`,
    );
    process.exitCode = 1;
} finally {
    if (clockChanged && originalClock && mongoose.connection.readyState === 1) {
        try {
            await models.Config.updateOne(
                { key: "mockNow" },
                { $set: { value: originalClock } },
                { runValidators: true },
            );
        } catch {
            process.stderr.write(
                "Clock restoration failed; restore the seed time through /admin/clock before using the demo.\n",
            );
            process.exitCode = 1;
        }
    }
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
}
