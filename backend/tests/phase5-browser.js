import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createSessionManager } from "../src/agent/tools/sessions.js";
import { createBrowserTools } from "../src/agent/tools/browser.js";
import { createApprovalHarness } from "./helpers/phase5-harness.js";

const html = `<!doctype html><title>Browser fixture</title><time id="site-time">10 Oct 2026, 2 pm IST</time><main><div role="alert">Check details</div><label>Name<input id="name" name="name" value="Demo"></label><input aria-label="Secret" type="password" value="dont-expose"><input aria-label="Hidden" hidden><button disabled>Disabled</button><input aria-label="Read only" readonly value="fixed"><select aria-label="Sport"><option value="cricket">Cricket</option><option value="tennis">Tennis</option><option disabled value="closed">Closed</option></select><label>Agree<input type="checkbox" name="confirm"></label><a href="/inbox">Inbox</a><a href="/admin/clock">Admin</a><a href="http://127.0.0.1:1/matches">External</a><a href="/matches?popup=1" target="_blank">Popup</a><a href="/matches?redirect=1">Redirect</a><button onclick="confirm('Unapproved?');">Dialog</button><form method="post" action="/profile"><label>Profile name<input name="name" value="Demo"></label><button data-risk="irreversible" onclick="return confirm('Save?')">Save profile</button></form><p>${"Visible content ".repeat(1000)}</p></main>`;

function element(snapshot, name) {
    const match = snapshot.elements.find((entry) => entry.name === name);
    assert.ok(match, `Missing ${name}`);
    return match.ref;
}

async function call(tools, name, args = {}) {
    const result = await tools.runTool(name, args);
    assert.equal(result.success, true, result.observation);
    return result.snapshot;
}

test("Phase 5 real Chromium tools, references, boundaries, sessions and approvals", async (t) => {
    let writes = 0;
    let forbidden = 0;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.get("/matches", (req, res) =>
        req.query.redirect ? res.redirect("/admin/clock") : res.send(html),
    );
    app.get("/inbox", (req, res) => res.send("<title>Inbox</title><main>Messages</main>"));
    app.all("/admin/clock", (req, res) => {
        forbidden++;
        res.send("Forbidden reached");
    });
    app.post("/profile", (req, res) => {
        writes++;
        res.send(`<title>Saved</title><main role="alert">Saved ${req.body.name}</main>`);
    });
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    const manager = createSessionManager({
        config: { SITE_URL: `http://127.0.0.1:${server.address().port}`, HEADLESS: true },
        userId: "100000000000000000000001",
        timeout: 1500,
    });

    try {
        const session = await manager.createSession("browser-fixture");
        const tools = createBrowserTools(manager, session.taskId);
        let snapshot;
        await t.test(
            "snapshot labels, hidden/disabled controls, clock, bounds and secret redaction",
            async () => {
                snapshot = await call(tools, "browser_goto", { url: "/matches" });
                assert.equal(snapshot.title, "Browser fixture");
                assert.equal(snapshot.siteTime, "10 Oct 2026, 2 pm IST");
                assert.deepEqual(snapshot.alerts, ["Check details"]);
                assert.equal(snapshot.truncated, true);
                assert.equal(
                    snapshot.elements.some((entry) => entry.name === "Hidden"),
                    false,
                );
                assert.equal(
                    snapshot.elements.find((entry) => entry.name === "Disabled").disabled,
                    true,
                );
                assert.equal(
                    snapshot.elements.find((entry) => entry.name === "Secret").value,
                    "[redacted]",
                );
                assert.equal(snapshot.readable.includes("dont-expose"), false);
                const oldRef = element(snapshot, "Name");
                snapshot = await call(tools, "browser_fill", { ref: oldRef, text: "Updated" });
                assert.equal(
                    snapshot.elements.find((entry) => entry.name === "Name").value,
                    "Updated",
                );
                assert.match(
                    (await tools.runTool("browser_fill", { ref: oldRef, text: "Stale" }))
                        .observation,
                    /Stale/,
                );
                assert.match(
                    (
                        await tools.runTool("browser_fill", {
                            ref: element(snapshot, "Read only"),
                            text: "Bad",
                        })
                    ).observation,
                    /editable/,
                );
                assert.match(
                    (await tools.runTool("browser_click", { ref: element(snapshot, "Disabled") }))
                        .observation,
                    /disabled/,
                );
            },
        );
        await t.test(
            "select/check/back, detached refs, real LangChain invocation and screenshots",
            async () => {
                snapshot = await call(tools, "browser_select", {
                    ref: element(snapshot, "Sport"),
                    option: "tennis",
                });
                assert.equal(
                    snapshot.elements.find((entry) => entry.name === "Sport").value,
                    "tennis",
                );
                assert.equal(
                    (
                        await tools.runTool("browser_select", {
                            ref: element(snapshot, "Sport"),
                            option: "closed",
                        })
                    ).success,
                    false,
                );
                snapshot = await call(tools, "browser_check", {
                    ref: element(snapshot, "Agree"),
                    checked: true,
                });
                assert.equal(
                    snapshot.elements.find((entry) => entry.name === "Agree").checked,
                    true,
                );
                const detached = element(snapshot, "Name");
                await session.page
                    .locator("#name")
                    .evaluate((entry) => entry.replaceWith(entry.cloneNode(true)));
                assert.equal(
                    (await tools.runTool("browser_fill", { ref: detached, text: "Wrong element" }))
                        .success,
                    false,
                );
                snapshot = await call(tools, "browser_snapshot");
                snapshot = await call(tools, "browser_click", { ref: element(snapshot, "Inbox") });
                assert.equal(snapshot.title, "Inbox");
                snapshot = await call(tools, "browser_back");
                const result = JSON.parse(
                    await tools.tools.find((entry) => entry.name === "browser_snapshot").invoke({}),
                );
                assert.equal(result.success, true);
                snapshot = result.snapshot;
                const evidence = await tools.runTool("browser_screenshot", { label: "fixture" });
                assert.equal(evidence.success, true);
                assert.match(evidence.path, /evidence\/browser-fixture\/fixture-/);
            },
        );
        await t.test("boundary blocks direct, clicked, redirected and popup routes", async () => {
            assert.equal(
                (await tools.runTool("browser_goto", { url: "/admin/clock" })).success,
                false,
            );
            for (const name of ["Admin", "External", "Redirect"]) {
                snapshot = await call(tools, "browser_goto", { url: "/matches" });
                const result = await tools.runTool("browser_click", {
                    ref: element(snapshot, name),
                });
                assert.equal(result.success, false);
            }
            snapshot = await call(tools, "browser_goto", { url: "/matches" });
            await tools.runTool("browser_click", { ref: element(snapshot, "Popup") });
            assert.equal(forbidden, 0);
            assert.equal(session.context.pages().length, 1);
        });
        await t.test(
            "unapproved dialogs dismissed; approval rejection and single approved click",
            async () => {
                snapshot = await call(tools, "browser_goto", { url: "/matches" });
                const result = await tools.runTool("browser_click", {
                    ref: element(snapshot, "Dialog"),
                });
                assert.match(result.observation, /dismissed/);
                snapshot = result.snapshot;
                const harness = createApprovalHarness(tools, session.taskId);
                let paused = await harness.start(element(snapshot, "Save profile"));
                assert.equal(paused.__interrupt__[0].value.type, "approval");
                assert.equal(writes, 0);
                assert.equal(
                    (
                        await tools.runTool("browser_fill", {
                            ref: element(snapshot, "Profile name"),
                            text: "Changed",
                        })
                    ).success,
                    false,
                );
                const rejected = await harness.resume({
                    proposalId: harness.proposal.proposalId,
                    approved: false,
                });
                assert.match(rejected.result.observation, /rejected/);
                assert.equal(writes, 0);
                paused = await harness.start(element(snapshot, "Save profile"));
                const answer = { proposalId: harness.proposal.proposalId, approved: true };
                const resumed = await harness.resume(answer);
                assert.equal(resumed.result.success, true, resumed.result.observation);
                assert.match(resumed.result.observation, /accepted/);
                assert.equal(writes, 1);
                assert.equal(session.approvedClick, false);
                await assert.rejects(async () => harness.resume(answer), /No matching/);
            },
        );
        await t.test("changed form and cross-task approval cannot execute", async () => {
            snapshot = await call(tools, "browser_goto", { url: "/matches" });
            const harness = createApprovalHarness(tools, session.taskId);
            await harness.start(element(snapshot, "Save profile"));
            await session.page.locator("form input").fill("Changed while paused");
            const result = await harness.resume({
                proposalId: harness.proposal.proposalId,
                approved: true,
            });
            assert.match(result.result.observation, /changed/);
            assert.equal(writes, 1);
            await manager.createSession("other-task");
            const otherTools = createBrowserTools(manager, "other-task");
            const otherSnapshot = await call(otherTools, "browser_goto", { url: "/matches" });
            assert.equal(
                otherSnapshot.elements.find((entry) => entry.name === "Profile name").value,
                "Demo",
            );
            const otherHarness = createApprovalHarness(otherTools, "other-task");
            await harness.start(element(snapshot, "Save profile"));
            await otherHarness.start(element(otherSnapshot, "Save profile"));
            await assert.rejects(
                async () =>
                    otherHarness.resume({
                        proposalId: harness.proposal.proposalId,
                        approved: true,
                    }),
                /No matching/,
            );
            await otherHarness.resume({
                proposalId: otherHarness.proposal.proposalId,
                approved: false,
            });
            await harness.resume({ proposalId: harness.proposal.proposalId, approved: false });
            await assert.rejects(manager.createSession("other-task"), /already exists/);
            await manager.closeSession("other-task");
            await manager.closeSession("other-task");
            assert.equal(manager.size, 1);
        });
        await t.test(
            "malformed, concurrent and detached-target resumes fail safely and recover",
            async () => {
                snapshot = await call(tools, "browser_goto", { url: "/matches" });
                const harness = createApprovalHarness(tools, session.taskId);
                await harness.start(element(snapshot, "Save profile"));
                const malformed = await harness.resume({
                    proposalId: harness.proposal.proposalId,
                    approved: "yes",
                });
                assert.match(malformed.result.observation, /Invalid/);
                assert.equal(writes, 1);

                await harness.start(element(snapshot, "Save profile"));
                await session.page
                    .locator("form button")
                    .evaluate((button) => button.replaceWith(button.cloneNode(true)));
                const detached = await harness.resume({
                    proposalId: harness.proposal.proposalId,
                    approved: true,
                });
                assert.equal(detached.result.success, false);
                assert.equal(session.pending, null);
                snapshot = await call(tools, "browser_snapshot");

                await harness.start(element(snapshot, "Save profile"));
                const answer = { proposalId: harness.proposal.proposalId, approved: false };
                const first = harness.resume(answer);
                await assert.rejects(harness.resume(answer), /already running/);
                await first;
                assert.equal(writes, 1);

                await harness.start(element(snapshot, "Save profile"));
                await session.page
                    .locator("form button")
                    .evaluate((button) => button.removeAttribute("data-risk"));
                const changedRisk = await harness.resume({
                    proposalId: harness.proposal.proposalId,
                    approved: true,
                });
                assert.match(changedRisk.result.observation, /changed/);
                assert.equal(writes, 1);
            },
        );
        await t.test(
            "approved click timeout clears dialog permission without retrying",
            async () => {
                snapshot = await call(tools, "browser_goto", { url: "/matches" });
                const harness = createApprovalHarness(tools, session.taskId);
                await harness.start(element(snapshot, "Save profile"));
                // Test-only obstruction changes clickability, not the approved form details.
                await session.page.evaluate(() => {
                    const overlay = document.createElement("div");
                    overlay.id = "test-overlay";
                    overlay.style.cssText = "position:fixed;inset:0;z-index:99999";
                    document.body.append(overlay);
                });
                const timeout = await harness.resume({
                    proposalId: harness.proposal.proposalId,
                    approved: true,
                });
                assert.equal(timeout.result.success, false);
                assert.match(timeout.result.observation, /uncertain/);
                assert.equal(session.approvedClick, false);
                assert.equal(writes, 1);
                await session.page.locator("#test-overlay").evaluate((entry) => entry.remove());
                snapshot = await call(tools, "browser_snapshot");
                const dialog = await tools.runTool("browser_click", {
                    ref: element(snapshot, "Dialog"),
                });
                assert.match(dialog.observation, /dismissed/);
            },
        );
        await t.test("mobile refs remain usable and two tasks have separate cookies", async () => {
            await session.page.setViewportSize({ width: 390, height: 844 });
            snapshot = await call(tools, "browser_goto", { url: "/matches" });
            assert.ok(element(snapshot, "Name"));
            await manager.createSession("cookie-isolation");
            const other = manager.getSession("cookie-isolation");
            await other.context.clearCookies();
            assert.equal((await other.context.cookies()).length, 0);
            assert.equal(
                (await session.context.cookies()).find((cookie) => cookie.name === "uid").value,
                "100000000000000000000001",
            );
            await manager.closeSession("cookie-isolation");
        });
    } finally {
        await manager.closeAll();
        assert.equal(manager.size, 0);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
