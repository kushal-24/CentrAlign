import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { chromium } from "playwright";
import { app } from "../src/site/server.js";
import { Match, Booking, Waitlist, Outbox, User } from "../src/site/models/index.js";
import { preparePhase4World, siteRecords } from "../tests/helpers/phase4-world.js";

let server, browser;
let stage = "prepare isolated test world";
const evidence = fileURLToPath(new URL("../evidence/phase4/", import.meta.url));
const errors = [];
try {
    const data = await preparePhase4World();
    const mainUser = data.users[0];
    await mkdir(evidence, { recursive: true });
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const goto = async (path) => {
        const response = await page.goto(base + path);
        assert.equal(response.status(), 200, path);
        assert.equal(
            await page.locator("#site-time").getAttribute("datetime"),
            "2026-10-10T08:30:00.000Z",
        );
    };
    const alertContains = async (text) => {
        assert.ok(
            (await page.locator('[role="alert"]').allTextContents()).join(" ").includes(text),
        );
    };
    const noOverflow = async () =>
        assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            "Page overflows horizontally",
        );
    const book = async (match, quantity = "1") => {
        await goto(`/matches/${match._id}/book`);
        await page.getByLabel("Number of tickets").fill(quantity);
        await page.getByLabel("I confirm the event").check();
        await page.getByRole("button", { name: "Confirm booking" }).click();
        await page.waitForURL(/\/bookings\/[a-f\d]{24}\?created=1/);
        await alertContains("Booking confirmed");
        return Booking.findOne({
            matchId: match._id,
            userId: mainUser._id,
            status: "booked",
        }).lean();
    };
    stage = "session and profile";
    await goto("/matches");
    await page.getByRole("button", { name: "Open demo session", exact: true }).click();
    await page.waitForURL("**/bookings");
    assert.equal(await page.locator(".booking-card").count(), 2);
    const uid = (await context.cookies()).find((cookie) => cookie.name === "uid");
    assert.ok(uid.httpOnly && uid.sameSite === "Lax");
    await page.getByRole("link", { name: "My Profile", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Matchday Reader");
    await page.getByLabel("Phone number", { exact: true }).fill("+919777777777");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForURL("**/profile?saved=1");
    assert.equal((await User.findById(mainUser._id)).name, "Matchday Reader");
    assert.equal((await Booking.findById(data.bookings[0]._id)).ownerName, mainUser.name);
    await page.screenshot({ path: evidence + "profile-desktop.png", fullPage: true });
    stage = "paid ticket and free RSVP";
    await goto(`/matches/${data.matches[2]._id}/book`);
    assert.equal(
        await page.getByLabel("Attendee name", { exact: true }).inputValue(),
        "Matchday Reader",
    );
    const beforePartial = await siteRecords();
    const partial = await context.request.post(`${base}/matches/${data.matches[2]._id}/book`, {
        form: {
            quantity: "3",
            ownerName: "Reader",
            ownerEmail: "reader@example.com",
            phone: "+919000000001",
            confirm: "yes",
        },
        headers: { Origin: base },
        maxRedirects: 0,
    });
    assert.equal(partial.status(), 409);
    assert.ok((await partial.text()).includes("Only 2 tickets left"));
    assert.equal(await siteRecords(), beforePartial);

    const paid = await book(data.matches[2], "2");
    assert.equal(paid.totalPrice, 1600);
    assert.equal((await Match.findById(paid.matchId)).sold, 20);
    assert.equal(
        await Outbox.countDocuments({ relatedBookingId: paid._id, type: "booking_confirmation" }),
        1,
    );
    await page.screenshot({ path: evidence + "ticket-desktop.png", fullPage: true });
    const free = await book(data.matches[10]);
    assert.equal(free.totalPrice, 0);
    assert.equal((await Match.findById(free.matchId)).sold, 1);
    stage = "dismissed and confirmed cancellation, zero refund";
    await goto(`/bookings/${data.bookings[0]._id}`);
    await page.getByLabel("I confirm cancellation").check();
    const beforeDismiss = await siteRecords();
    const dismiss = page.waitForEvent("dialog").then((dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Cancel booking", exact: true }).click();
    await dismiss;
    assert.equal(await siteRecords(), beforeDismiss);
    const accept = page.waitForEvent("dialog").then((dialog) => dialog.accept());
    await page.getByRole("button", { name: "Cancel booking", exact: true }).click();
    await accept;
    await page.waitForURL("**?cancelled=1");
    await alertContains("Booking cancelled");
    assert.equal((await Booking.findById(data.bookings[0]._id)).refundAmount, 1000);
    await goto(`/bookings/${data.bookings[1]._id}`);
    assert.ok((await page.locator(".cancel-refund").innerText()).includes("₹0"));
    await page.getByLabel("I confirm cancellation").check();
    const acceptZero = page.waitForEvent("dialog").then((dialog) => dialog.accept());
    await page.getByRole("button", { name: "Cancel booking", exact: true }).click();
    await acceptZero;
    await page.waitForURL("**?cancelled=1");
    assert.equal((await Booking.findById(data.bookings[1]._id)).refundAmount, 0);
    stage = "waitlist and inbox";
    await goto(`/matches/${data.matches[6]._id}/waitlist`);
    await page.getByLabel("Number of tickets").fill("2");
    await page.getByLabel("I confirm this event").check();
    await page.getByRole("button", { name: "Join waitlist", exact: true }).click();
    await page.waitForURL(/\/bookings\?joined=/);
    await alertContains("position 1");
    assert.equal(
        (await Waitlist.findOne({ matchId: data.matches[6]._id, userId: mainUser._id })).quantity,
        2,
    );
    assert.equal((await Match.findById(data.matches[6]._id)).sold, 17);
    await goto("/inbox");
    assert.equal(await page.locator(".message-card").count(), 7);
    stage = "hard-rule rejection through HTTP forms with unchanged DB";
    const beforeInvalid = await siteRecords();
    const validForm = {
        quantity: "1",
        ownerName: "Reader",
        ownerEmail: "reader@example.com",
        phone: "+919000000001",
        confirm: "yes",
    };
    const reject = async (path, form, expected) => {
        const response = await context.request.post(base + path, {
            form,
            headers: { Origin: base },
            maxRedirects: 0,
        });
        assert.equal(response.status(), expected, path);
        assert.ok((await response.text()).includes('role="alert"'));
    };
    for (const [index, form, status] of [
        [0, validForm, 409],
        [13, validForm, 409],
        [11, validForm, 409],
        [6, validForm, 409],
        [7, { ...validForm, quantity: "3" }, 400],
        [2, validForm, 409],
        [4, { ...validForm, quantity: "0" }, 400],
        [4, { ...validForm, quantity: "1.5" }, 400],
        [4, { ...validForm, ownerEmail: "bad" }, 400],
        [4, { ...validForm, phone: "bad" }, 400],
        [4, { ...validForm, confirm: "no" }, 400],
    ]) {
        await reject(`/matches/${data.matches[index]._id}/book`, form, status);
    }
    await reject(`/bookings/${data.bookings[0]._id}/cancel`, { confirm: "yes" }, 409);
    await reject(`/bookings/${data.bookings[2]._id}/cancel`, { confirm: "yes" }, 404);
    await reject(
        `/matches/${data.matches[6]._id}/waitlist`,
        { quantity: "1", confirm: "yes" },
        409,
    );
    await reject(
        `/matches/${data.matches[4]._id}/waitlist`,
        { quantity: "1", confirm: "yes" },
        409,
    );
    assert.equal(await siteRecords(), beforeInvalid);
    stage = "responsive forms";
    for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of [
            "/profile",
            `/matches/${data.matches[4]._id}/book`,
            `/matches/${data.matches[6]._id}/waitlist`,
            `/bookings/${paid._id}`,
        ]) {
            await goto(path);
            await noOverflow();
        }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await goto(`/matches/${data.matches[4]._id}/book`);
    await page.screenshot({ path: evidence + "booking-mobile.png", fullPage: true });
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
        await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
        "auto",
    );
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("button", { name: "Close demo session" }).click();
    await page.waitForURL("**/matches");
    assert.equal((await page.goto(base + "/profile")).status(), 401);
    await context.close();
    stage = "forms without JavaScript";
    const noJs = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 390, height: 844 },
    });
    const plain = await noJs.newPage();
    await plain.goto(base + "/matches");
    await plain.getByRole("button", { name: "Open demo session", exact: true }).click();
    await plain.waitForURL("**/bookings");
    await plain.goto(`${base}/matches/${data.matches[4]._id}/book`);
    await plain.getByLabel("I confirm the event").check();
    await plain.getByRole("button", { name: "Confirm booking" }).click();
    await plain.waitForURL(/\/bookings\/[a-f\d]{24}\?created=1/);
    const noJsBooking = await Booking.findOne({
        matchId: data.matches[4]._id,
        userId: mainUser._id,
        status: "booked",
    });
    assert.equal(noJsBooking.totalPrice, data.matches[4].price);
    await plain.getByLabel("I confirm cancellation").check();
    await plain.getByRole("button", { name: "Cancel booking", exact: true }).click();
    await plain.waitForURL("**?cancelled=1");
    assert.equal((await Booking.findById(noJsBooking._id)).status, "cancelled");
    await noJs.close();
    assert.deepEqual(errors, []);
    process.stdout.write(
        "PASS Phase 4 browser + DB: one-click session, profile, paid/free booking, cancellation/rejection/refunds, waitlist/inbox, invalid requests without writes, responsive forms, reduced motion, and no-JS booking/cancellation. Only MatchDay_phase4_test was mutated.\n",
    );
} catch (error) {
    process.stderr.write(
        `Phase 4 verification failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : error.name === "TimeoutError" ? error.message.split("Call log:")[0] : "Check test reset authorization, database access, local ports, and Chromium."}\n`,
    );
    process.exitCode = 1;
} finally {
    if (browser) await browser.close();
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
}
