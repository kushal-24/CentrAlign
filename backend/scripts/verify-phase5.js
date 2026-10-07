import assert from "node:assert/strict";
import mongoose from "mongoose";
import { readConfig } from "../src/config.js";
import { app } from "../src/site/server.js";
import { createSessionManager } from "../src/agent/tools/sessions.js";
import { createBrowserTools } from "../src/agent/tools/browser.js";
import { createApprovalDriver } from "../tests/helpers/production-approval.js";
import { preparePhase5World, siteRecords } from "../tests/helpers/phase5-world.js";
import { Booking, Match, Outbox, Waitlist, User } from "../src/site/models/index.js";

// Testing-only caller chooses labels from snapshots; actions use generic refs.
const userId = "100000000000000000000001";
const matchId = (number) => `20${number.toString(16).padStart(22, "0")}`;
let server;
let manager;
let snapshot;
const results = [];

function find(name, predicate = () => true) {
    const entry = snapshot.elements.find((element) => element.name === name && predicate(element));
    assert.ok(entry, `Snapshot is missing ${name}`);
    return entry.ref;
}

try {
    await preparePhase5World();
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    manager = createSessionManager({
        config: {
            ...readConfig(process.env, { requireStudent: true }),
            SITE_URL: `http://127.0.0.1:${server.address().port}`,
            HEADLESS: true,
        },
    });
    const session = await manager.createSession("phase5-actions");
    const tools = createBrowserTools(manager, session.taskId);
    const harness = createApprovalDriver(tools, session.taskId);

    async function call(name, args = {}) {
        const result = await tools.runTool(name, args);
        assert.equal(result.success, true, result.observation);
        snapshot = result.snapshot ?? snapshot;
        return result;
    }
    async function go(path) {
        await call("browser_goto", { url: path });
    }
    async function fill(name, text) {
        await call("browser_fill", { ref: find(name), text });
    }
    async function confirm() {
        const checkbox = snapshot.elements.find((element) => element.type === "checkbox");
        assert.ok(checkbox);
        await call("browser_check", { ref: checkbox.ref, checked: true });
    }
    async function act(name, approved) {
        const before = await siteRecords();
        const paused = await harness.start(find(name));
        assert.equal(paused.__interrupt__?.length, 1);
        assert.equal(await siteRecords(), before, "Writes before approval");
        const answer = { proposalId: harness.proposal.proposalId, approved };
        const completed = await harness.resume(answer);
        assert.equal(completed.result.success, approved, completed.result.observation);
        if (!approved) assert.equal(await siteRecords(), before, "Rejected action changed records");
        else snapshot = completed.result.snapshot;
        await assert.rejects(async () => harness.resume(answer), /No matching/);
        return completed.result;
    }

    await go("/matches?status=upcoming&sport=cricket&location=India");
    assert.ok(snapshot.siteTime.includes("10 Oct 2026"));
    results.push("Tool-only discovery and mock-clock snapshot");

    await go(`/matches/${matchId(3)}/book`);
    await fill("Number of tickets", "2");
    await confirm();
    await act("Confirm booking", false);
    results.push("Rejected booking: no changes to any site records");
    await act("Confirm booking", true);
    const paid = await Booking.findOne({ userId, matchId: matchId(3), status: "booked" }).lean();
    assert.ok(paid);
    assert.equal(paid.quantity, 2);
    assert.equal(paid.totalPrice, 1600);
    assert.equal((await Match.findById(matchId(3)).lean()).sold, 20);
    assert.equal(
        await Outbox.countDocuments({ relatedBookingId: paid._id, type: "booking_confirmation" }),
        1,
    );
    await call("browser_screenshot", { label: "approved-ticket" });
    results.push("Paid booking: one record, correct price/inventory/receipt");

    await go(`/matches/${matchId(11)}/book`);
    await confirm();
    await act("Confirm booking", true);
    const free = await Booking.findOne({ userId, matchId: matchId(11), status: "booked" }).lean();
    assert.equal(free.totalPrice, 0);
    await confirm();
    await act("Cancel booking", false);
    const cancellation = await act("Cancel booking", true);
    assert.match(cancellation.observation, /accepted/);
    assert.equal((await Booking.findById(free._id).lean()).status, "cancelled");
    assert.equal((await Booking.findById(free._id).lean()).refundAmount, 0);
    results.push("Free RSVP and cancellation: rejected unchanged, approved dialog accepted");

    for (const [bookingId, refund] of [
        ["300000000000000000000001", 1000],
        ["300000000000000000000002", 0],
    ]) {
        const beforeBooking = await Booking.findById(bookingId).lean();
        const beforeMatch = await Match.findById(beforeBooking.matchId).lean();
        await go(`/bookings/${bookingId}`);
        await confirm();
        await act("Cancel booking", true);
        const afterBooking = await Booking.findById(bookingId).lean();
        assert.equal(afterBooking.status, "cancelled");
        assert.equal(afterBooking.refundAmount, refund);
        assert.equal(
            (await Match.findById(beforeBooking.matchId).lean()).sold,
            beforeMatch.sold - beforeBooking.quantity,
        );
        assert.equal(
            await Outbox.countDocuments({ relatedBookingId: bookingId, type: "cancellation" }),
            1,
        );
    }
    results.push("Full and zero refund cancellations: inventory restored and receipts created");

    await go(`/matches/${matchId(7)}/waitlist`);
    await fill("Number of tickets", "2");
    await confirm();
    await act("Join waitlist", false);
    await act("Join waitlist", true);
    const waitlist = await Waitlist.findOne({ userId, matchId: matchId(7) }).lean();
    assert.equal(waitlist.quantity, 2);
    assert.equal(waitlist.position, 1);
    assert.equal((await Match.findById(matchId(7)).lean()).sold, 17);
    assert.equal(
        await Outbox.countDocuments({
            to: (await User.findById(userId).lean()).email,
            type: "waitlist_joined",
        }),
        1,
    );
    results.push("Waitlist approval/rejection: position and receipt, inventory unchanged");

    await go("/profile");
    const originalUser = await User.findById(userId).lean();
    await fill("Name", "Phase Five Student");
    await fill("Phone number", "+919111111111");
    await act("Save profile ↗", false);
    await harness.start(find("Save profile ↗"));
    const unchanged = await siteRecords();
    await session.page.locator('input[name="name"]').fill("Changed while paused");
    const changed = await harness.resume({
        proposalId: harness.proposal.proposalId,
        approved: true,
    });
    assert.equal(changed.result.success, false);
    assert.match(changed.result.observation, /changed/);
    assert.equal(await siteRecords(), unchanged);
    await call("browser_snapshot");
    await fill("Name", "Phase Five Student");
    await act("Save profile ↗", true);
    const updatedUser = await User.findById(userId).lean();
    assert.equal(updatedUser.name, "Phase Five Student");
    assert.equal(updatedUser.phone, "+919111111111");
    assert.equal(updatedUser.email, originalUser.email);
    assert.equal((await Booking.findById(paid._id).lean()).ownerName, paid.ownerName);
    results.push(
        "Profile: changed proposal invalidated; fresh approval saves only intended fields",
    );
    await call("browser_screenshot", { label: "approved-profile" });

    await go(`/matches/${matchId(3)}/book`);
    await confirm();
    await act("Confirm booking", true);
    assert.ok(snapshot.alerts.length, "Expected site validation alert");
    assert.equal(
        await Booking.countDocuments({ userId, matchId: matchId(3), status: "booked" }),
        1,
    );
    results.push("Site validation is observed without automatic submission retry");

    await go("/inbox");
    assert.ok(snapshot.text.includes("Phase Five") || snapshot.text.includes("Booking"));
    await session.page.setViewportSize({ width: 390, height: 844 });
    await go("/matches");
    assert.equal(
        snapshot.elements.some((entry) => entry.name === "Inbox"),
        false,
    );
    await call("browser_click", { ref: find("Menu") });
    assert.ok(find("Inbox"));
    await call("browser_click", { ref: find("Inbox") });
    assert.ok(snapshot.title.includes("Inbox"));
    await call("browser_screenshot", { label: "mobile-inbox" });
    results.push("Mobile menu: hidden refs excluded, generic click exposes links and navigates");
    await manager.closeAll();
    assert.equal(manager.size, 0);
    console.log(
        JSON.stringify(
            { database: "MatchDay_phase5_test", checks: results, sessionsRemaining: manager.size },
            null,
            2,
        ),
    );
} finally {
    await manager?.closeAll();
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
}
