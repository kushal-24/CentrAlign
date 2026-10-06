import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { app } from "../src/site/server.js";
import { Match, Booking, Waitlist, Outbox, User, Config } from "../src/site/models/index.js";
import { bookTickets, cancelTicket } from "../src/site/services/booking.service.js";
import { joinEventWaitlist } from "../src/site/services/waitlist.service.js";
import { preparePhase4World, siteRecords } from "./helpers/phase4-world.js";

// Explicit runner; excluded from npm test because it resets the isolated test database.
test("Phase 4 real MongoDB outcomes, concurrency and rollback", async (t) => {
    const data = await preparePhase4World();
    const user = data.users[0];
    const input = { quantity: 1, ownerName: user.name, ownerEmail: "attendee@example.com" };
    let freeBooking;
    let server;

    try {
        await t.test(
            "paid and free bookings persist correct inventory, receipts and mock timestamps",
            async () => {
                const beforePartial = await siteRecords();
                await assert.rejects(
                    bookTickets(data.matches[2]._id, user, { ...input, quantity: 3 }),
                    /Only 2/,
                );
                assert.equal(await siteRecords(), beforePartial);

                const paid = await bookTickets(data.matches[2]._id, user, {
                    ...input,
                    quantity: 2,
                });
                freeBooking = await bookTickets(data.matches[10]._id, user, input);
                assert.equal(paid.totalPrice, 1600);
                assert.equal(freeBooking.totalPrice, 0);
                assert.equal((await Match.findById(paid.matchId)).sold, 20);
                assert.equal((await Match.findById(freeBooking.matchId)).sold, 1);

                for (const booking of [paid, freeBooking]) {
                    assert.equal(booking.userId.toString(), user._id.toString());
                    assert.equal(booking.createdAt.getTime(), Date.parse(data.config[0].value));
                    const receipts = await Outbox.find({
                        relatedBookingId: booking._id,
                        type: "booking_confirmation",
                    }).lean();
                    assert.equal(receipts.length, 1);
                    assert.equal(receipts[0].to, user.email);
                    assert.equal(receipts[0].createdAt.getTime(), booking.createdAt.getTime());
                }
            },
        );

        await t.test("hard-rule failures leave all site records unchanged", async () => {
            const before = await siteRecords();

            for (const [index, quantity, message] of [
                [0, 1, /closed/],
                [13, 1, /closed/],
                [11, 1, /postponed/],
                [6, 1, /sold out/],
                [7, 3, /Maximum/],
                [8, 1, /already/],
            ]) {
                await assert.rejects(
                    bookTickets(data.matches[index]._id, user, { ...input, quantity }),
                    message,
                );
            }

            await assert.rejects(
                joinEventWaitlist(data.matches[4]._id, user, 1),
                /still available/,
            );
            await assert.rejects(
                cancelTicket(data.bookings[2]._id, user._id),
                /could not be found/,
            );
            assert.equal(await siteRecords(), before);
        });

        await t.test("last-seat and duplicate races produce at most one booking", async () => {
            const lastSeat = data.matches[3]._id;
            await Match.updateOne({ _id: lastSeat }, { $set: { capacity: 1 } });
            const outcomes = await Promise.allSettled([
                bookTickets(lastSeat, data.users[1], input),
                bookTickets(lastSeat, data.users[2], input),
            ]);
            assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
            assert.equal((await Match.findById(lastSeat)).sold, 1);
            assert.equal(await Booking.countDocuments({ matchId: lastSeat }), 1);

            const duplicate = data.matches[7]._id;
            const duplicateOutcomes = await Promise.allSettled([
                bookTickets(duplicate, user, input),
                bookTickets(duplicate, user, input),
            ]);
            assert.equal(
                duplicateOutcomes.filter((result) => result.status === "fulfilled").length,
                1,
            );
            assert.equal(
                await Booking.countDocuments({
                    matchId: duplicate,
                    userId: user._id,
                    status: "booked",
                }),
                1,
            );
            const booking = await Booking.findOne({ matchId: duplicate, userId: user._id });
            assert.equal(await Outbox.countDocuments({ relatedBookingId: booking._id }), 1);
        });

        await t.test("outbox failures roll booking and cancellation writes back", async () => {
            const before = await siteRecords();
            const create = t.mock.method(Outbox, "create", async () => {
                throw new Error("Injected receipt failure");
            });

            try {
                await assert.rejects(bookTickets(data.matches[9]._id, user, input), /Injected/);
                await assert.rejects(cancelTicket(data.bookings[0]._id, user._id), /Injected/);
            } finally {
                create.mock.restore();
            }

            assert.equal(await siteRecords(), before);
        });

        await t.test(
            "full, zero and free refunds persist; duplicate cancellation restores once",
            async () => {
                const full = await cancelTicket(data.bookings[0]._id, user._id);
                const zero = await cancelTicket(data.bookings[1]._id, user._id);
                const free = await cancelTicket(freeBooking._id, user._id);
                assert.equal(full.refundAmount, 1000);
                assert.equal(zero.refundAmount, 0);
                assert.equal(free.refundAmount, 0);
                assert.equal((await Match.findById(full.matchId)).sold, 0);
                assert.equal((await Match.findById(zero.matchId)).sold, 0);
                assert.equal((await Match.findById(free.matchId)).sold, 0);

                for (const booking of [full, zero, free]) {
                    const stored = await Booking.findById(booking._id);
                    assert.equal(stored.status, "cancelled");
                    assert.equal(stored.cancelledAt.getTime(), Date.parse(data.config[0].value));
                    assert.equal(
                        await Outbox.countDocuments({
                            relatedBookingId: booking._id,
                            type: "cancellation",
                        }),
                        1,
                    );
                }

                const duplicate = await Booking.findOne({
                    matchId: data.matches[7]._id,
                    userId: user._id,
                });
                const outcomes = await Promise.allSettled([
                    cancelTicket(duplicate._id, user._id),
                    cancelTicket(duplicate._id, user._id),
                ]);
                assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
                assert.equal((await Match.findById(duplicate.matchId)).sold, 0);
                assert.equal(
                    await Outbox.countDocuments({
                        relatedBookingId: duplicate._id,
                        type: "cancellation",
                    }),
                    1,
                );
                const before = await siteRecords();
                await assert.rejects(cancelTicket(full._id, user._id), /already cancelled/);
                assert.equal(await siteRecords(), before);
            },
        );

        await t.test(
            "waitlist positions are unique, inventory stays unchanged and failures roll back",
            async () => {
                const matchId = data.matches[6]._id;
                const entry = await joinEventWaitlist(matchId, user, 1);
                const outcomes = await Promise.allSettled([
                    joinEventWaitlist(matchId, data.users[1], 1),
                    joinEventWaitlist(matchId, data.users[2], 2),
                ]);
                assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 2);
                const entries = await Waitlist.find({ matchId }).sort({ position: 1 }).lean();
                assert.deepEqual(
                    entries.map((record) => record.position),
                    [1, 2, 3],
                );
                assert.equal((await Match.findById(matchId)).sold, 17);
                assert.equal(await Outbox.countDocuments({ type: "waitlist_joined" }), 3);
                assert.equal(entry.createdAt.getTime(), Date.parse(data.config[0].value));
                const before = await siteRecords();
                await assert.rejects(
                    joinEventWaitlist(matchId, user, 1),
                    /already on the waitlist/,
                );
                const create = t.mock.method(Outbox, "create", async () => {
                    throw new Error("Injected receipt failure");
                });

                try {
                    await assert.rejects(joinEventWaitlist(matchId, data.users[3], 1), /Injected/);
                } finally {
                    create.mock.restore();
                }

                assert.equal(await siteRecords(), before);
            },
        );

        await t.test(
            "refund cutoff is inclusive and started events cannot be cancelled",
            async () => {
                const match = data.matches[4];
                const booking = await bookTickets(match._id, user, input);
                const cutoff = new Date(
                    match.startsAt.getTime() - match.refundFullHoursBefore * 3600000,
                );
                await Config.updateOne(
                    { key: "mockNow" },
                    { $set: { value: cutoff.toISOString() } },
                );
                assert.equal(
                    (await cancelTicket(booking._id, user._id)).refundAmount,
                    booking.totalPrice,
                );
                const other = await bookTickets(match._id, user, input);
                await Config.updateOne(
                    { key: "mockNow" },
                    { $set: { value: new Date(cutoff.getTime() + 1).toISOString() } },
                );
                assert.equal((await cancelTicket(other._id, user._id)).refundAmount, 0);
                const started = await bookTickets(match._id, user, input);
                await Config.updateOne(
                    { key: "mockNow" },
                    { $set: { value: match.startsAt.toISOString() } },
                );
                const before = await siteRecords();
                await assert.rejects(cancelTicket(started._id, user._id), /no longer/);
                assert.equal(await siteRecords(), before);
                await Config.updateOne(
                    { key: "mockNow" },
                    { $set: { value: data.config[0].value } },
                );
            },
        );

        await t.test("real HTTP profile update only changes name and phone", async () => {
            server = await new Promise((resolve, reject) => {
                const listener = app.listen(0, "127.0.0.1");
                listener.once("listening", () => resolve(listener));
                listener.once("error", reject);
            });
            const base = `http://127.0.0.1:${server.address().port}`;
            const before = JSON.parse(await siteRecords());
            const response = await fetch(base + "/profile", {
                method: "POST",
                redirect: "manual",
                headers: {
                    Cookie: `uid=${user._id}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                    Origin: base,
                },
                body: new URLSearchParams({ name: "Phase Four Reader", phone: "+919888888888" }),
            });
            assert.equal(response.status, 303);
            const saved = await User.findById(user._id);
            assert.equal(saved.name, "Phase Four Reader");
            assert.equal(saved.phone, "+919888888888");
            assert.equal(saved.email, user.email);
            const after = JSON.parse(await siteRecords());
            const edited = before.users.find((record) => record._id === user._id.toString());
            edited.name = saved.name;
            edited.phone = saved.phone;
            assert.deepEqual(after, before);
        });
    } finally {
        if (server) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        await mongoose.disconnect();
    }
});
