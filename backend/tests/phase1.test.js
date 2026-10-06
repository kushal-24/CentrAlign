import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";
import { app as siteApp } from "../src/site/server.js";
import { app as agentApp } from "../src/agent/index.js";
import { graphSmoke } from "../scripts/smoke.js";

const base = { MONGODB_URI: "mongodb://127.0.0.1:27017" };

test("configuration defaults and explicit headless parsing", () => {
    const config = readConfig(base);
    assert.equal(config.SITE_PORT, 4000);
    assert.equal(config.AGENT_PORT, 5000);
    assert.equal(config.MAX_STEPS, 25);
    assert.equal(config.HEADLESS, false);
    assert.equal(readConfig({ ...base, HEADLESS: "true" }).HEADLESS, true);
});

test("configuration rejects malformed values without revealing them", () => {
    for (const input of [
        { MONGODB_URI: "secret-value" },
        { ...base, AGENT_PORT: "5000junk" },
        { ...base, MAX_STEPS: "0" },
        { ...base, HEADLESS: "yes" },
        { ...base, SITE_URL: "ftp://localhost" },
        { ...base, SITE_PORT: "5000" },
    ]) {
        assert.throws(
            () => readConfig(input),
            (error) => !error.message.includes("secret-value"),
        );
    }
});

test("full configuration requires Gemini and the seeded user email", () => {
    assert.throws(() => readConfig(base, { requireGemini: true }), /GEMINI_API_KEY/);
    assert.throws(() => readConfig(base, { requireStudent: true }), /STUDENT_EMAIL/);
    assert.equal(
        readConfig(
            { ...base, GEMINI_API_KEY: "test-key", STUDENT_EMAIL: "student@example.com" },
            { requireGemini: true, requireStudent: true },
        ).STUDENT_EMAIL,
        "student@example.com",
    );
});

async function withServer(app, check) {
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    try {
        await check(`http://127.0.0.1:${server.address().port}`);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

test("site redirects to browsing and health reports disconnected Mongo accurately", async () => {
    await withServer(siteApp, async (url) => {
        const page = await fetch(url, { redirect: "manual" });
        assert.equal(page.status, 302);
        assert.equal(page.headers.get("location"), "/matches");
        const unavailable = await fetch(`${url}/matches`);
        assert.equal(unavailable.status, 503);
        assert.match(await unavailable.text(), /role="alert"/);
        const health = await fetch(`${url}/health`);
        assert.equal(health.status, 503);
        assert.equal((await health.json()).data.database, "disconnected");
    });
});

test("agent health starts and later-phase task routes remain unavailable", async () => {
    await withServer(agentApp, async (url) => {
        const health = await fetch(`${url}/health`);
        assert.equal(health.status, 503);
        assert.equal((await health.json()).data.service, "MatchPilot");
        assert.equal((await fetch(`${url}/tasks`, { method: "POST" })).status, 404);
    });
});

test("LangGraph pauses and resumes the same saved thread", graphSmoke);
