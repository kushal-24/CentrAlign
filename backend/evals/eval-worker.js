import mongoose from "mongoose";
import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "../src/config.js";
import { app } from "../src/site/server.js";
import { createRuntime } from "../src/agent/runtime.js";
import { EVALUATION_DATABASE, requireEvaluationDatabase } from "../tests/helpers/eval-world.js";

// Harness caller only: production runtime owns the graph, tools and verification.
export async function runEvaluationTask(scenario, confirmation) {
    requireEvaluationDatabase(confirmation);
    const config = readConfig(process.env, { requireLLM: true, requireStudent: true });
    let server;
    let runtime;
    const interactions = [];
    const seen = new Set();
    let answerIndex = 0;
    let approvalIndex = 0;
    const send = (data) => {
        if (process.connected) process.send(data, () => {});
    };
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            dbName: EVALUATION_DATABASE,
            autoCreate: false,
            autoIndex: false,
            serverSelectionTimeoutMS: 10000,
        });
        requireEvaluationDatabase(confirmation, mongoose.connection);
        server = await new Promise((resolve, reject) => {
            const listener = app.listen(0, "127.0.0.1");
            listener.once("listening", () => resolve(listener));
            listener.once("error", reject);
        });
        // Own the local site; never browse an external/configured normal demo server.
        runtime = createRuntime({
            config: {
                ...config,
                HEADLESS: true,
                SITE_URL: `http://127.0.0.1:${server.address().port}`,
            },
        });
        const { taskId } = await runtime.startTask(scenario.task);
        send({ type: "started", taskId });
        for (;;) {
            const run = await runtime.readRun(taskId);
            const trace = await runtime.readTrace(taskId);
            send({ type: "progress", taskId, run, trace, interactions });
            const active = runtime.getActiveTask(taskId);
            if (["done", "failed"].includes(run?.status) && !active?.running)
                return { taskId, run, trace, interactions };
            // Persisted interrupt can appear before graph streaming has finished pausing.
            if (active?.paused && !active.running && run?.pendingInterrupt) {
                const pending = run.pendingInterrupt;
                const id = pending.questionId ?? pending.proposalId;
                if (seen.has(id)) throw new Error("Harness refused a replayed interrupt.");
                seen.add(id);
                if (pending.type === "input") {
                    const scripted = scenario.answers[answerIndex++];
                    if (
                        !scripted ||
                        !new RegExp(scripted.questionPattern, "i").test(pending.question)
                    )
                        throw new Error("Unexpected human question; no scripted answer supplied.");
                    interactions.push({
                        type: "input",
                        question: pending.question,
                        answer: scripted.answer,
                    });
                    send({ type: "interaction", interactions });
                    await runtime.resumeTask(taskId, "input", {
                        questionId: pending.questionId,
                        answer: scripted.answer,
                    });
                } else if (pending.type === "approval") {
                    const scripted = scenario.approvals[approvalIndex++];
                    const details = pending.details;
                    const matches =
                        scripted &&
                        details &&
                        Object.entries(scripted.action).filter(([key]) => key !== "expectedPosition").every(
                            ([key, value]) => details[key] === value,
                        );
                    // Never auto-approve unexpected targets, quantities, attendees, costs or refunds.
                    const approved = Boolean(matches && scripted.approved);
                    interactions.push({
                        type: "approval",
                        matched: Boolean(matches),
                        approved,
                        details,
                    });
                    send({ type: "interaction", interactions });
                    await runtime.resumeTask(taskId, "approval", {
                        proposalId: pending.proposalId,
                        approved,
                    });
                    if (!matches) throw new Error("Unexpected approval proposal was rejected.");
                } else throw new Error("Unsupported interrupt type.");
            }
            await delay(200);
        }
    } finally {
        await runtime?.closeRuntime();
        if (server) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        await mongoose.disconnect();
    }
}

if (process.send && process.argv[2] === "--worker") {
    process.once("message", async ({ scenario, confirmation }) => {
        try {
            const result = await runEvaluationTask(scenario, confirmation);
            if (process.connected) process.send({ type: "result", ...result }, () => {});
        } catch {
            // Raw provider/browser errors can contain credentials; production trace is in Mongo.
            if (process.connected) process.send({
                type: "error",
                error: "Evaluation worker failed; inspect its saved trace and configuration.",
            }, () => {});
            process.exitCode = 1;
        } finally {
            if (process.connected) process.disconnect();
        }
    });
}
