import { fork } from "node:child_process";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { z } from "zod";
import { readConfig } from "../src/config.js";
import { checkAction } from "../src/agent/verification.js";
import { AgentRun } from "../src/site/models/index.js";
import {
    EVALUATION_DATABASE,
    requireEvaluationDatabase,
    resetEvaluationWorld,
    readEvaluationWorld,
} from "../tests/helpers/eval-world.js";

const id = z.string().regex(/^[a-f\d]{24}$/i);
const actionSchema = z.discriminatedUnion("kind", [
    z
        .object({
            kind: z.literal("book"),
            matchId: id,
            title: z.string().min(1),
            quantity: z.number().int().positive(),
            total: z.number().nonnegative(),
            ownerName: z.string().min(1),
            ownerEmail: z.string().min(1),
        })
        .strict(),
    z
        .object({
            kind: z.literal("cancel"),
            matchId: id,
            bookingId: id,
            title: z.string().min(1),
            quantity: z.number().int().positive(),
            refund: z.number().nonnegative(),
        })
        .strict(),
    z
        .object({
            kind: z.literal("waitlist"),
            matchId: id,
            title: z.string().min(1),
            quantity: z.number().int().positive(),
            expectedPosition: z.number().int().positive(),
        })
        .strict(),
    z
        .object({ kind: z.literal("profile"), name: z.string().min(1), phone: z.string().min(1) })
        .strict(),
]);
const scenarioSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        category: z.string().min(1),
        task: z.string().min(1).max(3000),
        demo: z.boolean().default(false),
        timeoutMs: z.number().int().min(1000).max(1800000).default(600000),
        answers: z
            .array(
                z
                    .object({ questionPattern: z.string().min(1), answer: z.string().min(1) })
                    .strict(),
            )
            .default([]),
        approvals: z
            .array(z.object({ approved: z.boolean(), action: actionSchema }).strict())
            .default([]),
        expected: z
            .object({
                status: z.enum(["done", "failed"]),
                unchanged: z.boolean(),
                action: actionSchema.optional(),
                summaryPatterns: z.array(z.string().min(1)).default([]),
                recordAssertions: z
                    .array(
                        z
                            .object({
                                collection: z.enum([
                                    "users",
                                    "matches",
                                    "bookings",
                                    "waitlist",
                                    "outbox",
                                    "config",
                                ]),
                                filter: z.record(
                                    z.string(),
                                    z.union([z.string(), z.number(), z.boolean(), z.null()]),
                                ),
                                count: z.number().int().nonnegative(),
                            })
                            .strict(),
                    )
                    .default([]),
            })
            .strict(),
    })
    .strict();

function optionsFrom(args) {
    const options = { repeat: 1, demoOnly: false };
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (flag === "--demo-only") options.demoOnly = true;
        else if (["--confirm-reset", "--tasks", "--report", "--repeat"].includes(flag)) {
            const value = args[++index];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
            options[flag.slice(2)] = value;
        } else throw new Error(`Unknown option: ${flag}.`);
    }
    requireEvaluationDatabase(options["confirm-reset"]);
    options.repeat = Number(options.repeat);
    if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 20)
        throw new Error("--repeat must be an integer from 1 to 20.");
    return options;
}

async function runWorker(scenario, confirmation, signal) {
    return new Promise((resolveResult) => {
        const child = fork(
            fileURLToPath(new URL("./eval-worker.js", import.meta.url)),
            ["--worker"],
            {
                env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
                stdio: ["ignore", "inherit", "inherit", "ipc"],
                detached: process.platform !== "win32",
            },
        );
        let latest = { interactions: [] };
        let outcome;
        let timedOut = false;
        let killTimer;
        function terminate(signal) {
            try {
                // Terminate the owned process group, including Chromium descendants, on Unix.
                if (process.platform !== "win32") process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch (error) {
                if (error.code !== "ESRCH") latest.cleanupError = "Worker termination failed.";
            }
        }
        const timer = setTimeout(() => {
            timedOut = true;
            terminate("SIGTERM");
            killTimer = setTimeout(() => terminate("SIGKILL"), 2000);
        }, scenario.timeoutMs);
        const interrupt = () => {
            latest.interrupted = true;
            terminate("SIGTERM");
            killTimer ??= setTimeout(() => terminate("SIGKILL"), 2000);
        };
        signal?.addEventListener("abort", interrupt, { once: true });
        if (signal?.aborted) interrupt();
        child.on("message", (message) => {
            if (message.type === "result") outcome = message;
            else if (message.type === "error") latest.workerError = message.error;
            else latest = { ...latest, ...message };
        });
        child.on("error", () => {
            latest.workerError = "Could not start evaluation worker.";
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            if (timedOut || latest.interrupted) terminate("SIGKILL");
            resolveResult({
                ...latest,
                ...outcome,
                timedOut,
                exitCode: code,
                signal,
                workerCompleted: Boolean(outcome),
            });
        });
        child.once("close", () => signal?.removeEventListener("abort", interrupt));
        child.send({ scenario, confirmation }, (error) => {
            if (error) {
                latest.workerError = "Could not send scenario to worker.";
                terminate("SIGTERM");
            }
        });
    });
}

function actionState(world, email) {
    const user = world.users.find((entry) => entry.email === email);
    return { ...world, user, now: world.config.find((entry) => entry.key === "mockNow")?.value };
}

function assertScenario(scenario, before, after, execution, email) {
    const assertions = [];
    const check = (name, passed, details) =>
        assertions.push({
            name,
            passed: Boolean(passed),
            ...(details === undefined ? {} : { details }),
        });
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    check(
        "worker completed within timeout",
        execution.workerCompleted && !execution.timedOut && execution.exitCode === 0,
    );
    check("expected terminal status", execution.run?.status === scenario.expected.status, {
        expected: scenario.expected.status,
        actual: execution.run?.status ?? null,
    });
    check(
        "result agrees with terminal status",
        execution.run?.result?.success === (scenario.expected.status === "done"),
    );
    const inputs = execution.interactions.filter((entry) => entry.type === "input");
    const approvals = execution.interactions.filter((entry) => entry.type === "approval");
    check("all scripted questions consumed", inputs.length === scenario.answers.length);
    check(
        "all scripted approvals consumed and matched",
        approvals.length === scenario.approvals.length &&
            approvals.every(
                (entry, index) =>
                    entry.matched && entry.approved === scenario.approvals[index].approved,
            ),
    );
    for (const pattern of scenario.expected.summaryPatterns)
        check(
            `summary matches ${pattern}`,
            new RegExp(pattern, "i").test(execution.run?.result?.summary ?? ""),
        );
    if (scenario.expected.unchanged) {
        for (const collection of Object.keys(before))
            check(`${collection}: no records changed`, same(before[collection], after[collection]));
    } else {
        const baseline = actionState(before, email);
        assertions.push(
            ...checkAction(baseline, actionState(after, email), scenario.expected.action, {
                userId: baseline.user._id,
                email,
            }).checks,
        );
        const action = scenario.expected.action;
        const expectedUsers = before.users.map((user) =>
            action.kind === "profile" && user._id === baseline.user._id
                ? { ...user, name: action.name, phone: action.phone }
                : user,
        );
        check("only intended user fields changed", same(expectedUsers, after.users));
        check("all config records unchanged", same(before.config, after.config));
        check(
            "exactly one matching action approved",
            approvals.filter((entry) => entry.approved).length === 1,
        );
        check(
            "production verification succeeded",
            execution.run?.result?.evidence?.success === true,
        );
    }
    for (const assertion of scenario.expected.recordAssertions) {
        const actual = after[assertion.collection].filter((record) =>
            Object.entries(assertion.filter).every(([key, value]) => record[key] === value),
        ).length;
        check(`${assertion.collection}: matching record count`, actual === assertion.count, {
            ...assertion,
            actual,
        });
    }
    check(
        "ordered persisted trace exists",
        Boolean(execution.trace?.steps?.length) &&
            execution.trace.steps.every((entry, index) => entry.sequence === index + 1),
    );
    return assertions;
}

async function saveReport(path, report) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
    await rename(temporary, path);
}

export async function main(args = process.argv.slice(2)) {
    const options = optionsFrom(args);
    const config = readConfig(process.env, { requireLLM: true, requireStudent: true });
    const email = config.STUDENT_EMAIL.toLowerCase().trim();
    const taskPath = options.tasks
        ? resolve(options.tasks)
        : fileURLToPath(new URL("./tasks.json", import.meta.url));
    const raw = await readFile(taskPath, "utf8");
    // Interpolate seed account only; scenario files cannot execute code.
    const scenarios = z
        .array(scenarioSchema)
        .min(1)
        .parse(
            JSON.parse(raw, (_key, value) =>
                typeof value === "string" ? value.replaceAll("{{studentEmail}}", email) : value,
            ),
        );
    if (new Set(scenarios.map((entry) => entry.id)).size !== scenarios.length)
        throw new Error("Scenario IDs must be unique.");
    for (const scenario of scenarios) {
        for (const pattern of [
            ...scenario.expected.summaryPatterns,
            ...scenario.answers.map((entry) => entry.questionPattern),
        ])
            new RegExp(pattern, "i");
        if (scenario.expected.unchanged === Boolean(scenario.expected.action))
            throw new Error("Each scenario must specify unchanged state or one expected action.");
        if (!scenario.expected.unchanged && scenario.expected.status !== "done")
            throw new Error("An expected action requires successful completion.");
        if (
            !scenario.expected.unchanged &&
            (scenario.approvals.length !== 1 ||
                !scenario.approvals[0].approved ||
                JSON.stringify(scenario.approvals[0].action) !==
                    JSON.stringify(scenario.expected.action))
        )
            throw new Error("Expected mutations require exactly one matching scripted approval.");
    }
    const selected = scenarios.filter((entry) => !options.demoOnly || entry.demo);
    if (!selected.length) throw new Error("No scenarios selected.");
    const startedAt = new Date().toISOString();
    const reportPath = options.report
        ? resolve(options.report)
        : fileURLToPath(
              new URL(
                  `../evidence/phase9/evals-${startedAt.replaceAll(":", "-")}.json`,
                  import.meta.url,
              ),
          );
    if (
        reportPath === taskPath ||
        !reportPath.endsWith(".json") ||
        !reportPath.startsWith(fileURLToPath(new URL("../evidence/", import.meta.url)))
    )
        throw new Error("Report must be a .json file inside backend/evidence/.");
    const report = {
        database: EVALUATION_DATABASE,
        startedAt,
        mode: "production-live-llm",
        provider: config.LLM_PROVIDER,
        repeat: options.repeat,
        results: [],
        summary: { total: 0, passed: 0, failed: 0 },
    };
    const started = performance.now();
    const lockOwner = randomUUID();
    let ownsLock = false;
    let stage = "connect";
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            dbName: EVALUATION_DATABASE,
            autoCreate: false,
            autoIndex: false,
            serverSelectionTimeoutMS: 10000,
        });
        requireEvaluationDatabase(options["confirm-reset"], mongoose.connection);
        stage = "acquire exclusive evaluation lock";
        // A second harness must never reset records while another worker is using them.
        await mongoose.connection.collection("evaluation_lock").insertOne({
            _id: "phase9",
            owner: lockOwner,
            startedAt,
        });
        ownsLock = true;
        for (let repetition = 1; repetition <= options.repeat; repetition++) {
            for (const scenario of selected) {
                controller.signal.throwIfAborted();
                // Each worker uses the production limiter. Separate workers need a fresh window.
                if (report.results.length) await delay(60000, undefined, { signal: controller.signal });
                controller.signal.throwIfAborted();
                const scenarioStarted = performance.now();
                stage = `reset ${scenario.id}`;
                const before = await resetEvaluationWorld(options["confirm-reset"], email);
                controller.signal.throwIfAborted();
                stage = `execute ${scenario.id}`;
                const execution = await runWorker(scenario, options["confirm-reset"], controller.signal);
                if (execution.cleanupError)
                    throw new Error("Worker cleanup failed; refusing further resets.");
                // Worker has exited before outcomes are inspected or the next reset starts.
                if (execution.taskId) {
                    execution.run = await AgentRun.findOne({ taskId: execution.taskId })
                        .select("-steps -__v")
                        .lean();
                    execution.trace = await AgentRun.findOne({ taskId: execution.taskId })
                        .select("taskId status steps")
                        .lean();
                }
                const after = await readEvaluationWorld();
                stage = `assert ${scenario.id}`;
                const assertions = assertScenario(scenario, before, after, execution, email);
                const failures = assertions.filter((entry) => !entry.passed);
                const result = {
                    id: scenario.id,
                    category: scenario.category,
                    repetition,
                    task: scenario.task,
                    passed: failures.length === 0,
                    assertions,
                    failures,
                    durationMs: Math.round(performance.now() - scenarioStarted),
                    steps: execution.trace?.steps?.length ?? 0,
                    execution,
                };
                report.results.push(result);
                report.summary = {
                    total: report.results.length,
                    passed: report.results.filter((entry) => entry.passed).length,
                    failed: report.results.filter((entry) => !entry.passed).length,
                };
                await saveReport(reportPath, report);
                process.stdout.write(
                    `${result.passed ? "PASS" : "FAIL"} ${scenario.id} (${repetition}) ${Math.round(result.durationMs / 1000)}s\n`,
                );
                const answer =
                    execution.run?.result?.summary ?? execution.run?.result?.failure ?? "(no answer)";
                process.stdout.write(`  Answer: ${String(answer).slice(0, 600)}\n`);
            }
        }
    } catch {
        report.interrupted = controller.signal.aborted;
        report.harnessFailure = {
            stage,
            message:
                "Evaluation setup, database operation or report generation failed. Check configuration, exclusive lock and transaction-capable MongoDB access.",
        };
        process.exitCode = 1;
    } finally {
        report.finishedAt = new Date().toISOString();
        report.durationMs = Math.round(performance.now() - started);
        try {
            if (ownsLock)
                await mongoose.connection.collection("evaluation_lock").deleteOne({
                    _id: "phase9",
                    owner: lockOwner,
                });
        } finally {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
            await mongoose.disconnect();
            await saveReport(reportPath, report);
        }
    }
    if (report.summary.failed) process.exitCode = 1;
    process.stdout.write(`Evaluation report: ${reportPath}\n`);
    return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(
            `Evaluation refused before execution: ${error instanceof z.ZodError ? "Invalid scenario schema." : error.message}\n`,
        );
        process.exitCode = 1;
    }
}
