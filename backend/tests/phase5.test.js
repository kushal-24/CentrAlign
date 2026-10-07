import test from "node:test";
import assert from "node:assert/strict";
import { allowedUrl } from "../src/agent/tools/navigation.js";
import { safeTaskId, createSessionManager } from "../src/agent/tools/sessions.js";
import { browserSchemas, createBrowserTools } from "../src/agent/tools/browser.js";
import { approvalSchema } from "../src/agent/tools/riskGate.js";
import { preparePhase5World } from "./helpers/phase5-world.js";

const site = "http://127.0.0.1:4000";
test("Phase 5 navigation permits website flows and excludes alternate/operator routes", () => {
    for (const path of [
        "/",
        "/matches?status=upcoming#explore",
        "/matches/200000000000000000000003",
        "/matches/200000000000000000000003/book",
        "/matches/200000000000000000000003/waitlist",
        "/bookings",
        "/bookings/300000000000000000000001",
        "/bookings/300000000000000000000001/cancel",
        "/profile",
        "/inbox",
        "/session/demo",
        "/session/close",
    ]) {
        assert.equal(allowedUrl(path, site), new URL(path, site).href);
    }

    for (const path of [
        "/admin/clock",
        "/tasks",
        "/tasks/demo/approve",
        "/other-page",
        "/matches/not-an-id/book",
        "/matches/200000000000000000000003/delete",
        "/matches/../admin/clock",
        "/%61dmin/clock",
        "/matches/%2e%2e/%61dmin/clock",
        "/matches%2f",
        "/health",
        "https://example.com/matches",
        "javascript:alert(1)",
        "http://name:pass@127.0.0.1:4000/matches",
    ]) {
        assert.throws(() => allowedUrl(path, site));
    }
});

test("Phase 5 schemas reject unsafe references, paths, arbitrary task IDs and malformed approvals", () => {
    for (const id of ["../x", "", "a/b", ".", "x".repeat(81)]) assert.throws(() => safeTaskId(id));
    for (const args of [{ ref: -1 }, { ref: "1" }, { ref: 1, taskId: "other" }])
        assert.equal(browserSchemas.browser_click.safeParse(args).success, false);
    assert.equal(browserSchemas.browser_screenshot.safeParse({ label: "../other" }).success, false);
    assert.equal(browserSchemas.browser_check.safeParse({ ref: 1, checked: "yes" }).success, false);
    assert.equal(approvalSchema.safeParse({ approved: true }).success, false);
});

test("Phase 5 tool registry has eight task-bound LangChain tools and missing sessions fail clearly", async () => {
    const manager = createSessionManager();
    const { tools, runTool } = createBrowserTools(manager, "offline");
    assert.deepEqual(
        tools.map((entry) => entry.name),
        Object.keys(browserSchemas),
    );
    assert.equal(
        (await runTool("browser_click", { ref: 0 })).observation,
        "Invalid tool arguments.",
    );
    assert.match((await runTool("browser_snapshot", {})).observation, /Unknown or closed/);
    await manager.closeSession("offline");
    await manager.closeAll();
    assert.equal(manager.size, 0);
});

test("Phase 5 database reset guard refuses missing or normal-database confirmation", async () => {
    const previous = process.env.PHASE5_TEST_RESET;
    try {
        for (const value of [undefined, "MatchDay", "admin", "MatchDay_phase4_test"]) {
            if (value === undefined) delete process.env.PHASE5_TEST_RESET;
            else process.env.PHASE5_TEST_RESET = value;
            await assert.rejects(preparePhase5World(), /Reset refused/);
        }
    } finally {
        if (previous === undefined) delete process.env.PHASE5_TEST_RESET;
        else process.env.PHASE5_TEST_RESET = previous;
    }
});

test("Phase 5 failed session setup releases its task reservation", async () => {
    const manager = createSessionManager({
        config: { SITE_URL: site, HEADLESS: true },
        userId: "invalid",
    });
    await assert.rejects(manager.createSession("failed-setup"), /Seeded demo user/);
    await assert.rejects(manager.createSession("failed-setup"), /Seeded demo user/);
    assert.equal(manager.size, 0);
    await manager.closeAll();
});
