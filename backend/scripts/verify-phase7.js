import assert from "node:assert/strict";
import mongoose from "mongoose";
import { readConfig } from "../src/config.js";
import { app as siteApp } from "../src/site/server.js";
import { createAgentApp } from "../src/agent/index.js";
import { createRuntime } from "../src/agent/runtime.js";
import { createLLM, createRateLimiter } from "../src/agent/llm.js";
import { createSessionManager } from "../src/agent/tools/sessions.js";
import { createScriptedModel } from "../tests/helpers/phase6-model.js";
import { preparePhase5World, siteRecords } from "../tests/helpers/phase5-world.js";

// Testing only: real HTTP, browser and MongoDB; scripted model drives the production graph.
// Reset is guarded by the existing explicit PHASE5_TEST_RESET test-database contract.
let siteServer;
const passed = [];

async function listen(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1");
        server.once("listening", () => resolve(server));
        server.once("error", reject);
    });
}

async function scenario(config, spec) {
    const manager = createSessionManager({ config });
    let taskId;
    const ownedManager = {
        ...manager,
        createSession: async (id) => {
            taskId = id;
            return manager.createSession(id);
        },
    };
    function ref(name, predicate = () => true) {
        const found = manager
            .getSession(taskId)
            .latestSnapshot.elements.find((entry) => entry.name === name && predicate(entry));
        assert.ok(found, `Missing control: ${name}`);
        return found.ref;
    }
    const intents = [
        ...(spec.questions ?? []).map((question) => () => ({
            name: "ask_human",
            args: { question },
        })),
        () => ({ name: "browser_goto", args: { url: new URL(spec.path, config.SITE_URL).href } }),
        ...(spec.fields ?? []).map(([name, text]) => () => ({
            name: "browser_fill",
            args: { ref: ref(name), text },
        })),
        ...(spec.confirm
            ? [
                  () => ({
                      name: "browser_check",
                      args: {
                          ref: manager
                              .getSession(taskId)
                              .latestSnapshot.elements.find((entry) => entry.type === "checkbox")
                              .ref,
                          checked: true,
                      },
                  }),
              ]
            : []),
        () => ({
            name: spec.directClick ? "browser_click" : "request_approval",
            args: { ref: ref(spec.submit) },
        }),
        () => ({ name: "finish", args: { summary: "Observed the requested website action." } }),
    ];
    let requests = 0;
    let model = createScriptedModel((index) => intents[index]?.() ?? intents.at(-1)(), {
        taskKind: "action",
    });
    if (spec.live) {
        const actual = createLLM();
        function bounded(request) {
            return {
                invoke: async (...args) => {
                    if (requests >= 12) throw new Error("Live request budget exhausted.");
                    requests++;
                    return request.invoke(...args);
                },
            };
        }
        model = {
            _llmType: () => actual._llmType(),
            withStructuredOutput: (schema) => bounded(actual.withStructuredOutput(schema)),
            bindTools: (tools, options) => bounded(actual.bindTools(tools, options)),
        };
    }
    const runtime = createRuntime({
        config,
        manager: ownedManager,
        model,
        limiter: spec.live
            ? createRateLimiter({ maxPerMinute: config.LLM_REQUESTS_PER_MINUTE ?? 4 })
            : undefined,
        modelOptions: { attempts: 1 },
    });
    const agentServer = await listen(createAgentApp(() => runtime));
    const origin = `http://127.0.0.1:${agentServer.address().port}`;
    const post = async (path, body) => {
        const response = await fetch(`${origin}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    async function settle() {
        await runtime.getActiveTask(taskId)?.job;
        return (await (await fetch(`${origin}/tasks/${taskId}`)).json()).data;
    }

    try {
        const before = await siteRecords();
        const accepted = await post("/tasks", { task: spec.name });
        assert.equal(accepted.status, 202);
        taskId = accepted.body.data.taskId;
        let run = await settle();
        let answers = 0;
        while (run.status === "needs_input") {
            assert.equal(await siteRecords(), before, "Writes while waiting for an answer");
            assert.ok(answers < (spec.live ? 4 : (spec.questions?.length ?? 0)));
            assert.equal(
                (
                    await post(`/tasks/${taskId}/answer`, {
                        questionId: run.pendingInterrupt.questionId,
                        answer: spec.answers?.[answers++] ?? "Use the shown choice and quantity.",
                    })
                ).status,
                202,
            );
            run = await settle();
        }
        assert.equal(run.status, "awaiting_approval", JSON.stringify(run.result));
        assert.equal(await siteRecords(), before, "Writes before approval");
        assert.equal(manager.size, 1);
        assert.ok(run.pendingInterrupt.details);
        if (spec.live) {
            assert.ok(answers > 0, "Live task did not exercise ask_human");
            assert.deepEqual(run.pendingInterrupt.details, {
                kind: "profile",
                name: "Phase Seven Live Student",
                phone: "+919876543210",
            });
        }
        if (spec.refund !== undefined)
            assert.equal(run.pendingInterrupt.details.refund, spec.refund);
        if (spec.conflict) assert.ok(run.pendingInterrupt.details.conflicts.length > 0);
        if (spec.changeForm)
            await manager
                .getSession(taskId)
                .page.locator('[name="name"]')
                .fill("Changed after proposal");

        const path = `/tasks/${taskId}/${spec.reject ? "reject" : "approve"}`;
        const payload = { proposalId: run.pendingInterrupt.proposalId };
        const responses = await Promise.all([post(path, payload), post(path, payload)]);
        assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
        run = await settle();
        assert.equal(
            run.status,
            spec.reject || spec.changeForm ? "failed" : "done",
            JSON.stringify(run.result),
        );
        assert.equal(run.pendingInterrupt, null);
        if (spec.reject || spec.changeForm)
            assert.equal(await siteRecords(), before, "Rejected/changed proposal wrote records");
        else {
            assert.equal(run.result.evidence.success, true);
            assert.ok(run.result.evidence.checks.every((check) => check.passed));
        }
        const trace = (await (await fetch(`${origin}/tasks/${taskId}/trace`)).json()).data;
        assert.deepEqual(
            trace.steps.map((entry) => entry.sequence),
            trace.steps.map((_, index) => index + 1),
        );
        assert.equal(trace.steps.filter((entry) => entry.node === "understand").length, 1);
        assert.equal(runtime.size, 0);
        assert.equal(manager.size, 0);
        assert.equal((await post(path, payload)).status, 409);
        passed.push(spec.name);
        process.stdout.write(`PASS ${spec.name}\n`);
    } finally {
        if (spec.live) process.stdout.write(`Live model requests used: ${requests}\n`);
        await runtime.closeRuntime();
        agentServer.closeAllConnections();
        await new Promise((resolve) => agentServer.close(resolve));
    }
}

try {
    await preparePhase5World();
    siteServer = await listen(siteApp);
    const config = {
        ...readConfig(process.env, { requireStudent: true }),
        HEADLESS: true,
        SITE_URL: `http://127.0.0.1:${siteServer.address().port}`,
        MAX_STEPS: 20,
    };
    const matchId = (number) => `20${number.toString(16).padStart(22, "0")}`;
    const booking = (number) => `/matches/${matchId(number)}/book`;
    const common = { confirm: true, submit: "Confirm booking" };
    const scenarios = [
        {
            ...common,
            name: "Rejected booking leaves every site record unchanged",
            path: booking(3),
            reject: true,
        },
        {
            name: "Changed profile form invalidates approval",
            path: "/profile",
            submit: "Save profile ↗",
            fields: [["Name", "Phase Seven Student"]],
            changeForm: true,
        },
        {
            ...common,
            name: "Ambiguity and revised quantity answers → paid booking → independent verification",
            path: booking(3),
            questions: [
                "Which India match: ODI or T20?",
                "The requested quantity is too large. Use two tickets instead?",
            ],
            answers: ["ODI in Bangalore", "Yes, two tickets"],
            fields: [["Number of tickets", "2"]],
        },
        { ...common, name: "Free RSVP → approval → verified zero-cost booking", path: booking(11) },
        {
            ...common,
            name: "Overlapping booking exposes conflict before approval",
            path: booking(10),
            questions: ["Tokyo overlaps your Kolkata booking. Proceed anyway?"],
            answers: ["Yes, proceed with Tokyo despite the overlap"],
            conflict: true,
        },
        {
            name: "Full-refund cancellation → approved dialog → verified inventory and receipt",
            path: "/bookings/300000000000000000000001",
            confirm: true,
            submit: "Cancel booking",
            directClick: true,
            refund: 1000,
        },
        {
            name: "Zero-refund cancellation discloses zero before approval",
            path: "/bookings/300000000000000000000002",
            confirm: true,
            submit: "Cancel booking",
            directClick: true,
            refund: 0,
        },
        {
            name: "Waitlist → verified queue position, receipt and unchanged inventory",
            path: `/matches/${matchId(7)}/waitlist`,
            confirm: true,
            submit: "Join waitlist",
            fields: [["Number of tickets", "2"]],
        },
        {
            name: "Profile edit → approval → verified name/phone and preserved tickets",
            path: "/profile",
            submit: "Save profile ↗",
            fields: [
                ["Name", "Phase Seven Student"],
                ["Phone number", "+919876543210"],
            ],
        },
    ];
    if (process.argv.includes("--live")) {
        const task =
            "Update only my profile name to Phase Seven Live Student and phone to +919876543210. First ask me to confirm these two values using ask_human and wait for my answer. Then open /profile, fill the fields, and request approval before submitting. After approval finish for independent verification. Do not change bookings, waitlist, email or anything else. One profile action only.";
        await scenario(config, {
            live: true,
            name: task,
            path: "/profile",
            submit: "Save profile ↗",
            answers: Array(4).fill(
                "Yes, set my name to Phase Seven Live Student and phone to +919876543210; leave everything else unchanged.",
            ),
        });
    } else for (const spec of scenarios) await scenario(config, spec);
    process.stdout.write(
        `PASS ${passed.length} Phase 7 browser/API/database scenarios; normal demo database untouched.\n`,
    );
} catch (error) {
    process.stderr.write(
        `${JSON.stringify({
            category: error.name,
            code: typeof error.code === "number" ? error.code : null,
            frames: error.stack
                ?.split("\n")
                .slice(1)
                .filter((line) => line.includes("CentrAlign"))
                .slice(0, 3),
        })}\n`,
    );
    process.stderr.write(
        `FAIL Phase 7 integration: ${error instanceof assert.AssertionError ? error.message : "Inspect local database/browser availability and configuration."}\n`,
    );
    process.exitCode = 1;
} finally {
    if (siteServer) {
        siteServer.closeAllConnections();
        await new Promise((resolve) => siteServer.close(resolve));
    }
    await mongoose.disconnect();
}
