import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as models from "../src/site/models/index.js";
import { getMatchStatus, getNow, getRefundAmount, parseInstant } from "../src/site/lib/clock.js";
import { buildSeedData, SEED_NOW } from "../src/site/seed/data.js";
import { RESET_COLLECTIONS, resetDemo, validateSeedData } from "../src/site/seed/seed.js";
import { localhostOnly } from "../src/controllers/clock.controller.js";
import { app } from "../src/site/server.js";
import mongoose from "mongoose";
import connectDB from "../src/db/index.js";
import { DB_NAME } from "../src/constants.js";

const data = buildSeedData("student@example.com");
const truth = JSON.parse(
    await readFile(new URL("../evals/ground_truth.json", import.meta.url), "utf8"),
);
const now = parseInstant(SEED_NOW);

test("database selection preserves the URI and explicitly selects the configured database", async (t) => {
    const original = process.env.MONGODB_URI;
    const uri = "mongodb://127.0.0.1:27017/?appName=phase2";
    process.env.MONGODB_URI = uri;
    const connect = t.mock.method(mongoose, "connect", async () => mongoose);
    try {
        await connectDB();
        assert.deepEqual(connect.mock.calls[0].arguments, [uri, { dbName: DB_NAME }]);
    } finally {
        if (original === undefined) delete process.env.MONGODB_URI;
        else process.env.MONGODB_URI = original;
        connect.mock.restore();
    }
});

test("seed is deterministic, validates, and matches independent ground truth", async () => {
    await validateSeedData(data);
    assert.deepEqual(buildSeedData("student@example.com"), data);
    for (const [collection, count] of Object.entries(truth.counts))
        assert.equal(data[collection].length, count);
    for (const expected of truth.matches) {
        const match = data.matches.find((record) => record._id.toString() === expected.id);
        assert.equal(getMatchStatus(match, now), expected.status);
        assert.equal(match.startsAt.toISOString(), expected.startsAt);
        assert.equal(match.endsAt.toISOString(), expected.endsAt);
        assert.equal(match.perBookingLimit, expected.perBookingLimit);
        assert.equal(match.isFree, expected.isFree);
        assert.equal(match.bookingStatus, expected.bookingStatus);
        assert.equal(match.refundFullHoursBefore, expected.refundFullHoursBefore);
        const bookingOpen =
            getMatchStatus(match, now) === "upcoming" && match.bookingStatus === "open";
        assert.equal(bookingOpen, expected.bookingOpen);
        assert.equal(
            bookingOpen && match.tiers.some((tier) => tier.sold < tier.capacity),
            expected.bookable,
        );
        assert.deepEqual(
            match.tiers.map((tier) => ({ ...tier, remaining: tier.capacity - tier.sold })),
            expected.tiers,
        );
    }
});

test("all inventory sales have corresponding valid bookings and confirmations", () => {
    for (const match of data.matches) {
        for (const tier of match.tiers) {
            const bookings = data.bookings.filter(
                (booking) => booking.matchId.equals(match._id) && booking.tier === tier.name,
            );
            assert.equal(
                bookings.reduce((sum, booking) => sum + booking.quantity, 0),
                tier.sold,
            );
        }
    }
    const uniqueBookings = new Set();
    for (const booking of data.bookings) {
        const match = data.matches.find((record) => record._id.equals(booking.matchId));
        const user = data.users.find((record) => record._id.equals(booking.userId));
        assert.ok(user);
        assert.ok(booking.quantity <= match.perBookingLimit);
        assert.equal(
            booking.totalPrice,
            booking.quantity * match.tiers.find((tier) => tier.name === booking.tier).price,
        );
        const key = `${booking.userId}:${booking.matchId}`;
        assert.ok(!uniqueBookings.has(key));
        uniqueBookings.add(key);
        const messages = data.outbox.filter((message) =>
            message.relatedBookingId.equals(booking._id),
        );
        assert.equal(messages.length, 1);
        assert.equal(messages[0].to, user.email);
        assert.equal(messages[0].createdAt.getTime(), booking.createdAt.getTime());
        assert.ok(messages[0].body.includes(booking.code));
        assert.ok(booking.createdAt <= now);
    }
    assert.equal(
        data.bookings.filter((booking) => booking.userId.toString() === truth.mainUserId).length,
        2,
    );
});

test("match status uses exact start/end boundaries and is never stored", () => {
    const match = data.matches[8];
    assert.equal(getMatchStatus(match, new Date(match.startsAt.getTime() - 1)), "upcoming");
    assert.equal(getMatchStatus(match, match.startsAt), "live");
    assert.equal(getMatchStatus(match, new Date(match.endsAt.getTime() - 1)), "live");
    assert.equal(getMatchStatus(match, match.endsAt), "past");
    assert.equal(models.Match.schema.path("status"), undefined);
});

test("refunds match ground truth including exact cutoff, start, zero, and free event", () => {
    for (const expected of truth.mainBookings) {
        const booking = data.bookings.find((record) => record._id.toString() === expected.id);
        const match = data.matches.find((record) => record._id.equals(booking.matchId));
        assert.equal(getRefundAmount(match, booking, now), expected.refundAtSeedNow);
        const cutoff = parseInstant(expected.fullRefundUntil);
        assert.equal(getRefundAmount(match, booking, cutoff), booking.totalPrice);
        assert.equal(getRefundAmount(match, booking, new Date(cutoff.getTime() + 1)), 0);
        assert.equal(getRefundAmount(match, booking, match.startsAt), 0);
        assert.equal(getRefundAmount(match, { ...booking, status: "cancelled" }, cutoff), 0);
    }
    assert.equal(getRefundAmount(data.matches[5], data.bookings[0], now), 0);
    assert.equal(getRefundAmount(data.matches[10], { status: "booked", totalPrice: 0 }, now), 0);
});

test("Tokyo and Kolkata actually overlap despite distinct local-time displays", () => {
    const [left, right] = truth.overlaps[0].matchIds.map((id) =>
        data.matches.find((match) => match._id.toString() === id),
    );
    assert.ok(left.startsAt < right.endsAt && right.startsAt < left.endsAt);
    assert.equal(
        new Date(Math.max(left.startsAt, right.startsAt)).toISOString(),
        truth.overlaps[0].startsAt,
    );
    assert.equal(
        new Date(Math.min(left.endsAt, right.endsAt)).toISOString(),
        truth.overlaps[0].endsAt,
    );
    assert.match(left.displayTime, /IST/);
    assert.match(right.displayTime, /JST/);
    assert.notEqual(left.displayTime, right.displayTime);
    assert.equal(data.matches[0].city, "Bengaluru");
    assert.equal(data.matches[2].city, "Bangalore");
});

test("clock reads the stored instant and refuses a missing clock", async (t) => {
    const findOne = t.mock.method(models.Config, "findOne", () => ({
        lean: async () => ({ value: SEED_NOW }),
    }));
    assert.equal((await getNow()).toISOString(), "2026-10-10T08:30:00.000Z");
    findOne.mock.mockImplementation(() => ({ lean: async () => null }));
    await assert.rejects(getNow(), /not initialized/);
    for (const value of ["not-a-date", "2026-02-30T10:00:00Z", "2026-10-10T14:00:00", undefined]) {
        assert.throws(() => parseInstant(value), /ISO timestamp/);
    }
});

test("models reject invalid quantities, inventory, dates, free pricing, and contact data", () => {
    const cases = [
        [models.User, { ...data.users[0], email: "invalid" }],
        [models.User, { ...data.users[0], phone: "abc" }],
        [models.Match, { ...data.matches[0], endsAt: data.matches[0].startsAt }],
        [
            models.Match,
            { ...data.matches[0], tiers: [{ name: "General", price: 10, capacity: 1, sold: 2 }] },
        ],
        [models.Match, { ...data.matches[0], isFree: true }],
        [models.Match, { ...data.matches[0], tiers: [] }],
        [
            models.Match,
            { ...data.matches[0], tiers: [data.matches[0].tiers[0], data.matches[0].tiers[0]] },
        ],
        [models.Booking, { ...data.bookings[0], quantity: 1.5 }],
        [models.Booking, { ...data.bookings[0], refundAmount: 1 }],
        [models.Booking, { ...data.bookings[0], status: "cancelled", cancelledAt: null }],
        [models.Booking, { ...data.bookings[0], createdAt: undefined }],
        [
            models.Waitlist,
            {
                matchId: data.matches[6]._id,
                userId: data.users[0]._id,
                tier: "General",
                quantity: 1,
                position: 0,
                createdAt: now,
            },
        ],
        [models.Outbox, { ...data.outbox[0], relatedBookingId: null }],
        [models.Config, { key: "mockNow", value: "invalid" }],
        [models.AgentRun, { taskId: "task", task: "discover", status: "invalid" }],
    ];
    for (const [Model, input] of cases) assert.ok(new Model(input).validateSync(), Model.modelName);
});

test("business schemas require explicit timestamps and active-booking index is partial", () => {
    for (const name of ["Booking", "Waitlist", "Outbox"]) {
        assert.equal(models[name].schema.options.timestamps, undefined);
        assert.equal(models[name].schema.path("createdAt").defaultValue, undefined);
        assert.equal(models[name].schema.path("createdAt").isRequired, true);
    }
    assert.ok(
        models.Booking.schema
            .indexes()
            .some(
                ([keys, options]) =>
                    keys.userId &&
                    keys.matchId &&
                    options.unique &&
                    options.partialFilterExpression.status === "booked",
            ),
    );
    assert.equal(models.AgentRun.collection.name, "agent_runs");
});

test("seed reset refuses the wrong database before any mutations", async () => {
    assert.deepEqual(RESET_COLLECTIONS, [
        "users",
        "matches",
        "bookings",
        "waitlist",
        "outbox",
        "config",
    ]);
    await assert.rejects(
        resetDemo({ name: "other_database" }, data, "other_database"),
        /confirmation/,
    );
    await assert.rejects(validateSeedData(buildSeedData("riya@example.com")), /unique/);
});

test("clock access uses the actual socket address and ignores spoofed headers", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
        localhostOnly({ socket: { remoteAddress: address } }, {}, (error) =>
            assert.equal(error, undefined),
        );
    }
    localhostOnly(
        { socket: { remoteAddress: "203.0.113.1" }, headers: { "x-forwarded-for": "127.0.0.1" } },
        {},
        (error) => assert.equal(error.statusCode, 403),
    );
});

test("clock endpoint validates JSON and instants without writing to disconnected Mongo", async () => {
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    try {
        const url = `http://127.0.0.1:${server.address().port}/admin/clock`;
        assert.equal((await fetch(url)).status, 503);
        for (const body of ['{"now":"invalid"}', '{"now":"2026-10-10T14:00:00"}', "{"]) {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });
            assert.equal(response.status, 400);
            assert.equal((await response.json()).success, false);
        }
        assert.equal(
            (
                await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ now: SEED_NOW }),
                })
            ).status,
            503,
        );
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
