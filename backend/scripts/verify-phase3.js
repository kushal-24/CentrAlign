import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import mongoose from "mongoose";
import { chromium } from "playwright";
import { readConfig } from "../src/config.js";
import { DB_NAME } from "../src/constants.js";
import * as models from "../src/site/models/index.js";
import { app } from "../src/site/server.js";
import { installSiteFixture } from "../tests/helpers/site-fixture.js";
import { RESET_COLLECTIONS } from "../src/site/seed/seed.js";

const fixtureMode = process.argv.length === 3 && process.argv[2] === "--fixture";
if (process.argv.length > 2 && !fixtureMode)
    throw new Error(
        "Use --fixture for offline browser validation, or no arguments for live read-only validation.",
    );
const evidence = fileURLToPath(new URL("../evidence/phase3/", import.meta.url));
let fixture, server, browser;
let stage = "connect";
const errors = [];
try {
    let mainUser;
    if (fixtureMode) {
        fixture = installSiteFixture(mock);
        mainUser = fixture.data.users[0];
    } else {
        const config = readConfig(process.env, { requireStudent: true });
        await mongoose.connect(process.env.MONGODB_URI, {
            dbName: DB_NAME,
            autoCreate: false,
            autoIndex: false,
            serverSelectionTimeoutMS: 10000,
        });
        mainUser = await models.User.findOne({
            email: config.STUDENT_EMAIL.toLowerCase().trim(),
        }).lean();
        assert.ok(mainUser, "The demo user is missing. Seed the dedicated demo database first.");
    }
    const snapshot = async () => {
        if (fixtureMode) return JSON.stringify(fixture.data);
        const records = {};
        for (const name of RESET_COLLECTIONS)
            records[name] = await mongoose.connection
                .collection(name)
                .find({})
                .sort({ _id: 1 })
                .toArray();
        return JSON.stringify(records);
    };
    const before = await snapshot();
    const truth = JSON.parse(
        await readFile(new URL("../evals/ground_truth.json", import.meta.url), "utf8"),
    );
    const matches = await models.Match.find({}).lean();
    for (const expected of truth.matches) {
        const record = matches.find((match) => match._id.toString() === expected.id);
        assert.ok(
            record && Number.isFinite(record.price),
            "Stored matches still use tiers. Approve and apply the revised Phase 2 demo seed before live verification.",
        );
        for (const field of ["price", "capacity", "sold"])
            assert.equal(record[field], expected[field]);
    }
    assert.equal(matches.length, 18);
    stage = "start local site and browser";
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: "uid", value: mainUser._id.toString(), url: base }]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const visit = async (path, expectedStatus = 200) => {
        const response = await page.goto(`${base}${path}`);
        assert.equal(response.status(), expectedStatus, path);
        assert.equal(
            await page.locator("#site-time").getAttribute("datetime"),
            "2026-10-10T08:30:00.000Z",
        );
        assert.equal(await page.locator("main h1").count(), 1);
        assert.equal(await page.locator('a[href="/admin/clock"]').count(), 0);
    };
    const noOverflow = async () =>
        assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            "Page overflows horizontally",
        );
    await mkdir(evidence, { recursive: true });
    stage = "desktop browsing";
    await visit("/matches");
    assert.equal(await page.locator(".match-card").count(), 18);
    await noOverflow();
    await page.screenshot({ path: `${evidence}discover-desktop.png`, fullPage: true });
    for (const [name, count] of [
        ["Live", 2],
        ["Upcoming", 11],
        ["Past", 5],
        ["All matches", 18],
    ]) {
        await page
            .getByRole("navigation", { name: "Match status" })
            .getByRole("link", { name, exact: true })
            .click();
        assert.equal(await page.locator(".match-card").count(), count);
        assert.equal(new URL(page.url()).hash, "#explore");
        await page.waitForFunction(() => {
            const top = document.querySelector("#explore").getBoundingClientRect().top;
            return top >= 0 && top < 100;
        });
    }
    await page.getByLabel("Sport", { exact: true }).selectOption("tennis");
    await page.getByLabel("Location", { exact: true }).fill("London");
    await page.getByRole("button", { name: "Find matches" }).click();
    assert.equal(await page.locator(".match-card").count(), 1);
    await page.getByRole("link", { name: "Upcoming", exact: true }).click();
    assert.equal(await page.getByLabel("Location", { exact: true }).inputValue(), "London");
    for (const [index, text] of [
        [2, "2 tickets remaining"],
        [6, "Sold out"],
        [10, "Free entry"],
        [11, "Postponed"],
    ]) {
        await visit(`/matches/${truth.matches[index].id}`);
        assert.ok((await page.locator("main").textContent()).includes(text));
    }
    await page.screenshot({ path: `${evidence}event-desktop.png`, fullPage: true });
    stage = "tickets and inbox";
    await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "My bookings" })
        .click();
    assert.equal(await page.locator(".booking-card").count(), 2);
    await page
        .locator(".booking-card")
        .filter({ hasText: "MD-1001" })
        .getByRole("link", { name: "View ticket" })
        .click();
    assert.ok((await page.locator(".booking-code").innerText()).includes("MD-1001"));
    await page.screenshot({ path: `${evidence}ticket-desktop.png`, fullPage: true });
    await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Inbox", exact: true })
        .click();
    assert.equal(await page.locator(".message-card").count(), 2);
    const allBookings = await models.Booking.find({}).lean();
    const other = allBookings.find(
        (booking) => booking.userId.toString() !== mainUser._id.toString(),
    );
    await visit(`/bookings/${other._id}`, 404);
    stage = "responsive layouts and keyboard navigation";
    for (const width of [1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of [
            "/matches",
            `/matches/${truth.matches[2].id}`,
            "/bookings",
            `/bookings/${truth.mainBookings[0].id}`,
            "/inbox",
            "/missing",
        ]) {
            await visit(path, path === "/missing" ? 404 : 200);
            await noOverflow();
        }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await visit("/matches");
    const menu = page.getByRole("button", { name: "Menu" });
    await menu.click();
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    assert.equal(await menu.evaluate((element) => element === document.activeElement), true);
    await menu.click();
    await page.getByRole("link", { name: "My bookings", exact: true }).click();
    assert.equal(await page.locator(".booking-card").count(), 2);
    await visit("/matches");
    await page.screenshot({ path: `${evidence}discover-mobile.png`, fullPage: true });
    await context.clearCookies();
    await visit("/bookings", 401);
    await visit("/inbox", 401);
    await context.close();
    const noJs = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 390, height: 844 },
    });
    const plainPage = await noJs.newPage();
    await plainPage.goto(`${base}/matches`);
    assert.equal(
        await plainPage.getByRole("navigation", { name: "Main navigation" }).isVisible(),
        true,
    );
    await noJs.close();
    assert.deepEqual(errors, []);
    assert.equal(await snapshot(), before, "Browsing changed stored records");
    process.stdout.write(
        `PASS ${fixtureMode ? "fixture" : "live read-only"}: filters, details, tickets, privacy, inbox, mock clock, responsive layouts, menu, no-JS navigation, and unchanged records. Screenshots: evidence/phase3/\n`,
    );
} catch (error) {
    process.stderr.write(
        `Phase 3 verification failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : "Check database access, local ports, and installed Chromium."}\n`,
    );
    process.exitCode = 1;
} finally {
    if (browser) await browser.close();
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    if (fixture) fixture.restore();
    else await mongoose.disconnect();
}
