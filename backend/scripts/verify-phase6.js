import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { readConfig } from "../src/config.js";
import connectDB from "../src/db/index.js";
import { app as siteApp } from "../src/site/server.js";
import { User, Match, Booking, Waitlist, Outbox, Config } from "../src/site/models/index.js";
import { createAgentApp } from "../src/agent/index.js";
import { createLLM } from "../src/agent/llm.js";
import { createRuntime } from "../src/agent/runtime.js";

// Explicit testing-only live Gemini probe. No seed/reset and no website mutations.
async function listen(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1");
        server.once("listening", () => resolve(server));
        server.once("error", reject);
    });
}

async function siteDigest() {
    const records = await Promise.all(
        [User, Match, Booking, Waitlist, Outbox, Config].map((model) =>
            model.find({}).sort({ _id: 1 }).lean(),
        ),
    );
    return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function createBudgetedModel(model, budget) {
    let used = 0;
    let failure = null;
    let lastStarted = -Infinity;

    function bounded(request) {
        return {
            invoke: async (...args) => {
                if (used >= budget) throw new Error("Live test request budget reached.");

                // Pace generation starts below five requests per minute across both tasks.
                const wait = Math.max(0, 16000 - (performance.now() - lastStarted));
                await delay(wait, undefined, { signal: args[1]?.signal });
                lastStarted = performance.now();
                used += 1;
                try {
                    return await request.invoke(...args);
                } catch (error) {
                    failure = {
                        status: error.status ?? null,
                        overloaded: /overloaded|high demand/i.test(error.message ?? ""),
                        unavailable: /unavailable|not available/i.test(error.message ?? ""),
                    };
                    throw error;
                }
            },
        };
    }

    return {
        _llmType: () => model._llmType(),
        withStructuredOutput: (schema) => bounded(model.withStructuredOutput(schema)),
        bindTools: (tools, options) => bounded(model.bindTools(tools, options)),
        get used() {
            return used;
        },
        get failure() {
            return failure;
        },
    };
}

const evidence = new URL("../evidence/phase6/", import.meta.url);
let siteServer;
let agentServer;
let runtime;
const results = [];
let budgetedModel;

try {
    const config = readConfig(process.env, { requireLLM: true, requireStudent: true });
    const budget = Number(process.env.PHASE6_REQUEST_BUDGET ?? 14);
    assert.ok(Number.isInteger(budget) && budget > 0 && budget <= 14);
    budgetedModel = createBudgetedModel(createLLM(), budget);
    process.stdout.write(
        `Live provider: ${config.LLM_PROVIDER}; model: ${config.LLM_PROVIDER === "groq" ? config.GROQ_MODEL : config.GEMINI_MODEL}\n`,
    );
    await connectDB();
    const before = await siteDigest();
    const clock = await Config.findOne({ key: "mockNow" }).lean();
    assert.ok(clock, "Seeded clock is required.");
    const expected = await Match.find({
        sport: "cricket",
        city: { $in: ["Bangalore", "Bengaluru"] },
        startsAt: { $gt: new Date(clock.value) },
        price: { $lte: 1000 },
        bookingStatus: "open",
    }).lean();

    siteServer = await listen(siteApp);
    runtime = createRuntime({
        model: budgetedModel,
        modelOptions: { attempts: 1 },
        config: {
            ...config,
            HEADLESS: true,
            MAX_STEPS: 5,
            SITE_URL: `http://127.0.0.1:${siteServer.address().port}`,
        },
    });
    agentServer = await listen(createAgentApp(() => runtime));
    const origin = `http://127.0.0.1:${agentServer.address().port}`;

    const locations =
        process.env.PHASE6_COMBINED_CHECK === "true"
            ? ["Bangalore (also called Bengaluru)"]
            : ["Bangalore", "Bengaluru"];
    for (const city of locations) {
        const response = await fetch(`${origin}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                task: `Find upcoming cricket matches in ${city} with a ticket price at most INR 1000. Read site time and open the MatchDay matches page with browser_goto. Show actual titles, prices and dates; do not book anything. Conserve the test quota: use at most five tool calls, no optional remember/screenshot calls.`,
            }),
        });
        assert.equal(response.status, 202);
        const { taskId } = (await response.json()).data;
        const deadline = performance.now() + 240000;
        let run;
        do {
            await new Promise((resolve) => setTimeout(resolve, 300));
            run = (await (await fetch(`${origin}/tasks/${taskId}`)).json()).data;
        } while (run.status === "running" && performance.now() < deadline);

        const trace = (await (await fetch(`${origin}/tasks/${taskId}/trace`)).json()).data;
        results.push({ city, taskId, status: run.status, result: run.result, steps: trace.steps });
        await mkdir(evidence, { recursive: true });
        await writeFile(new URL("results.json", evidence), JSON.stringify(results, null, 2));
        assert.equal(
            run.status,
            "done",
            `Live task ${city} did not complete; inspect evidence/phase6/results.json.`,
        );
        assert.ok(trace.steps.some((step) => step.tool === "db_query"));
        assert.ok(
            trace.steps.some((step) => step.tool === "browser_goto" && step.observation?.snapshot),
        );
        assert.deepEqual(
            trace.steps.map((step) => step.sequence),
            trace.steps.map((_, index) => index + 1),
        );
        if (expected.length)
            assert.ok(
                expected.some((match) =>
                    run.result.summary.toLowerCase().includes(match.title.toLowerCase()),
                ),
                "Answer must identify an actual matching event.",
            );
        else assert.match(run.result.summary, /no |none|not find|couldn't find/i);
        assert.equal(await siteDigest(), before, "Read-only task changed site records.");
        process.stdout.write(
            `PASS live ${city}: ${run.status}, ${trace.steps.length} trace entries\n`,
        );
    }
    assert.equal(runtime.size, 0);
    process.stdout.write("PASS read-only site digest and terminal browser cleanup\n");
} catch {
    process.stderr.write(
        "FAIL live Phase 6 verification. Check configuration, provider/site availability and evidence/phase6/results.json; raw errors withheld.\n",
    );
    process.exitCode = 1;
} finally {
    process.stdout.write(`Live model requests used: ${budgetedModel?.used ?? 0}\n`);
    if (budgetedModel?.failure)
        process.stdout.write(
            `Provider failure category: ${JSON.stringify(budgetedModel.failure)}\n`,
        );
    await runtime?.closeRuntime();
    for (const server of [agentServer, siteServer]) {
        if (!server) continue;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
}
