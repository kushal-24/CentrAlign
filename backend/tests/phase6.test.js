import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createAgentGraph } from "../src/agent/graph.js";
import { createInitialState } from "../src/agent/state.js";
import { createControlTools } from "../src/agent/tools/control.js";
import { createDbTool, validateQuery, serializeRecords } from "../src/agent/tools/db.js";
import { invokeModel, bindAgentTools } from "../src/agent/llm.js";
import { createRuntime } from "../src/agent/runtime.js";
import { createAgentApp } from "../src/agent/index.js";
import { createScriptedModel } from "./helpers/phase6-model.js";

const account = { userId: "100000000000000000000001", email: "student@example.com" };
const read = { name: "db_query", args: { collection: "matches", filter: "{}" } };
const finish = { name: "finish", args: { summary: "Observed cricket: INR 500." } };

test("Groq tool binding preserves schemas and requires a single tool selection", () => {
    let captured;
    const model = {
        _llmType: () => "groq",
        bindTools: (tools, options) => {
            captured = { tools, options };
            return model;
        },
    };
    const tools = createControlTools();
    assert.equal(bindAgentTools(model, tools), model);
    assert.equal(captured.tools, tools);
    assert.deepEqual(captured.options, { tool_choice: "required", parallel_tool_calls: false });
});

function registry(extra = []) {
    const tools = [...extra, ...createControlTools()];
    return { tools, byName: new Map(tools.map((entry) => [entry.name, entry])) };
}

function fixtureDb(records = [{ title: "Observed cricket", price: 500 }], capture = () => {}) {
    const model = {
        find(filter) {
            capture(filter);
            const query = {};
            for (const name of ["select", "sort", "limit", "maxTimeMS"]) query[name] = () => query;
            query.lean = async () => records;
            return query;
        },
    };
    return createDbTool(account, {
        models: Object.fromEntries(
            ["users", "matches", "bookings", "waitlist", "outbox", "config"].map((key) => [
                key,
                model,
            ]),
        ),
    });
}

async function runGraph(calls, options = {}) {
    let closed = 0;
    const context = {
        registry: registry([fixtureDb()]),
        model: createScriptedModel(calls, options),
        maxSteps: options.maxSteps ?? 15,
        siteUrl: "http://127.0.0.1:4000",
        closeSession: async () => {
            closed += 1;
        },
    };
    const graph = createAgentGraph({ getContext: () => context });
    const state = await graph.invoke(createInitialState(randomUUID(), "Find cricket"), {
        configurable: { thread_id: randomUUID() },
        recursionLimit: 120,
    });
    return { state, closed };
}

test("Phase 6 query validation rejects unsafe fields, methods, operators and values", () => {
    const badFilters = [
        '{"$where":"secret"}',
        '{"price":{"$set":5}}',
        '{"city":{"$regex":".*"}}',
        '{"__proto__":{}}',
        '{"constructor":{}}',
        '{"city.value":"Mumbai"}',
        '{"price":"500"}',
        '{"startsAt":"2026-02-30T00:00:00Z"}',
        '{"_id":"bad"}',
        '{"$and":[]}',
        "[]",
        "null",
        '{"city":{"$in":[]}}',
    ];
    for (const filter of badFilters) assert.throws(() => validateQuery({ ...read.args, filter }));
    for (const extra of [
        { collection: "agent_runs" },
        { limit: 21 },
        { operation: "deleteMany" },
        { projection: ["__v"] },
        { sort: { field: "secret", direction: "asc" } },
    ])
        assert.throws(() => validateQuery({ ...read.args, ...extra }));

    const safe = validateQuery({
        ...read.args,
        filter: '{"city":{"$contains":"Bengaluru.*"},"price":{"$lte":700},"startsAt":{"$gt":"2026-10-10T08:30:00Z"}}',
    });
    assert.equal(safe.filter.city.$regex, "Bengaluru\\.\\*");
    assert.ok(safe.filter.startsAt.$gt instanceof Date);
    assert.throws(() =>
        validateQuery({
            ...read.args,
            filter: JSON.stringify({
                $and: [{ $and: [{ $and: [{ $and: [{ sport: "cricket" }] }] }] }],
            }),
        }),
    );
    assert.equal(serializeRecords([{ body: "x".repeat(25000) }]).truncated, true);
});

test("Phase 6 private query scope cannot be overridden and only find is called", async () => {
    let captured;
    const db = fixtureDb([], (filter) => {
        captured = filter;
    });
    for (const collection of ["users", "bookings", "waitlist", "outbox"]) {
        const field = collection === "users" ? "_id" : collection === "outbox" ? "to" : "userId";
        const value = field === "to" ? "another@example.com" : "100000000000000000000002";
        const response = JSON.parse(
            await db.invoke({ collection, filter: JSON.stringify({ [field]: value }) }),
        );
        assert.equal(response.success, true);
        assert.equal(
            String(captured.$and[0][field]),
            field === "to" ? account.email : account.userId,
        );
        assert.equal(String(captured.$and[1][field]), value);
    }
});

test("Phase 6 production graph uses matched tool messages and grounded read completion", async () => {
    const { state, closed } = await runGraph([
        read,
        { name: "remember", args: { key: "price", value: "500" } },
        finish,
    ]);
    assert.equal(state.status, "done");
    assert.equal(state.result.summary, finish.args.summary);
    assert.equal(state.memory.price, "500");
    assert.equal(closed, 1);
    for (let index = 0; index < state.messages.length; index += 2)
        assert.equal(
            state.messages[index].tool_calls[0].id,
            state.messages[index + 1].tool_call_id,
        );
});

test("Phase 6 nudge, multiple/unknown tools, repeats and step cap cannot bypass the guard", async () => {
    assert.equal((await runGraph([null, read, finish])).state.status, "done");
    for (const calls of [[null], [[read, finish]], [{ name: "delete_all", args: {} }]]) {
        const { state } = await runGraph(calls);
        assert.equal(state.status, "failed");
        assert.equal(state.evidenceCount, 0);
    }
    const repeated = (await runGraph([read])).state;
    assert.match(repeated.result.summary, /Repeated action/);
    assert.equal(repeated.stepCount, 5);
    assert.match((await runGraph([read], { maxSteps: 2 })).state.result.summary, /step limit/);
    assert.equal((await runGraph([finish])).state.status, "failed");
    assert.match(
        (await runGraph([read, finish], { taskKind: "action" })).state.result.summary,
        /Phase 8/,
    );
});

test("Phase 6 reserves a finish-only turn after the last allowed action", async () => {
    const completed = await runGraph([read, finish], { maxSteps: 1 });
    assert.equal(completed.state.status, "done");
    assert.equal(completed.state.stepCount, 2);

    const blocked = await runGraph([read, read], { maxSteps: 1 });
    assert.equal(blocked.state.status, "failed");
    assert.equal(blocked.state.evidenceCount, 1);
    assert.match(blocked.state.result.summary, /step limit/);
});

test("Phase 6 invalid clock IDs receive actionable feedback without a database read", async () => {
    let reads = 0;
    const db = fixtureDb([], () => reads++);
    const response = JSON.parse(
        await db.invoke({ collection: "config", filter: '{"_id":"mockNow"}' }),
    );
    assert.equal(response.success, false);
    assert.match(response.observation, /Config settings use key/);
    assert.equal(reads, 0);
    assert.deepEqual(validateQuery({ collection: "config", filter: '{"key":"mockNow"}' }).filter, {
        key: "mockNow",
    });
});

test("Phase 6 model retries cap at four, permanent errors fail immediately and errors are sanitized", async () => {
    let calls = 0;
    const transient = {
        invoke: async () => {
            calls += 1;
            throw Object.assign(new Error("secret-provider-payload"), { status: 429 });
        },
    };
    await assert.rejects(
        invokeModel(transient, [], { delay: async () => {} }),
        (error) => !error.message.includes("secret"),
    );
    assert.equal(calls, 4);
    calls = 0;
    await assert.rejects(
        invokeModel(
            {
                invoke: async () => {
                    calls += 1;
                    throw Object.assign(new Error("bad"), { status: 400 });
                },
            },
            [],
        ),
    );
    assert.equal(calls, 1);
});

function memoryStore() {
    const records = new Map();
    return {
        records,
        createRun: async (taskId, task) =>
            records.set(taskId, { taskId, task, status: "running", steps: [] }),
        recordProgress: async (taskId, update) => {
            const record = records.get(taskId);
            for (const field of [
                "status",
                "goal",
                "successCriteria",
                "plan",
                "memory",
                "result",
                "pendingInterrupt",
            ])
                if (field in update) record[field] = update[field];
        },
        appendTrace: async (taskId, entry) => records.get(taskId).steps.push(entry),
        readRun: async (taskId) => records.get(taskId) ?? null,
        readTrace: async (taskId) => records.get(taskId) ?? null,
    };
}

function testRuntime(options = {}) {
    const store = memoryStore();
    const sessions = new Set();
    const manager = {
        createSession: async (id) => sessions.add(id),
        closeSession: async (id) => sessions.delete(id),
        closeAll: async () => sessions.clear(),
    };
    const runtime = createRuntime({
        config: { MAX_STEPS: 15, SITE_URL: "http://127.0.0.1:4000", STUDENT_EMAIL: account.email },
        store,
        manager,
        resolveAccount: async () => ({ _id: account.userId, email: account.email }),
        model: createScriptedModel([read, finish]),
        createTools: () => registry([fixtureDb()]),
        ...options,
    });
    return { runtime, store, sessions };
}

async function waitTask(runtime, taskId) {
    await runtime.getActiveTask(taskId)?.job;
}

test("Phase 6 runtime persists ordered per-task traces, cleans sessions and sanitizes failures", async () => {
    const { runtime, store, sessions } = testRuntime();
    const task = await runtime.startTask("Find cricket");
    assert.equal(store.records.has(task.taskId), true);
    await waitTask(runtime, task.taskId);
    const record = store.records.get(task.taskId);
    assert.equal(record.status, "done");
    assert.equal(record.steps[0].node, "understand");
    assert.equal(record.steps.at(-1).node, "complete");
    assert.deepEqual(
        record.steps.map((step) => step.sequence),
        record.steps.map((_, index) => index + 1),
    );
    assert.equal(runtime.size, 0);
    assert.equal(sessions.size, 0);
    await runtime.closeRuntime();

    const broken = testRuntime({
        resolveAccount: async () => {
            throw new Error("hidden credential");
        },
    });
    const failure = await broken.runtime.startTask("Read");
    await waitTask(broken.runtime, failure.taskId);
    assert.equal(broken.store.records.get(failure.taskId).status, "failed");
    assert.equal(
        JSON.stringify(broken.store.records.get(failure.taskId)).includes("credential"),
        false,
    );
    assert.equal(broken.runtime.size, 0);
});

test("Phase 6 HTTP accepts promptly, validates input and exposes persisted task and trace", async () => {
    const { runtime } = testRuntime();
    const server = createAgentApp(() => runtime).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        for (const body of [{}, { task: " " }, { task: "x", extra: true }])
            assert.equal(
                (
                    await fetch(`${origin}/tasks`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(body),
                    })
                ).status,
                400,
            );
        assert.equal(
            (
                await fetch(`${origin}/tasks`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{",
                })
            ).status,
            400,
        );
        const response = await fetch(`${origin}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task: "Find cricket" }),
        });
        assert.equal(response.status, 202);
        const { taskId } = (await response.json()).data;
        await waitTask(runtime, taskId);
        assert.equal((await (await fetch(`${origin}/tasks/${taskId}`)).json()).data.status, "done");
        assert.ok(
            (await (await fetch(`${origin}/tasks/${taskId}/trace`)).json()).data.steps.length,
        );
        assert.equal((await fetch(`${origin}/tasks/no`)).status, 400);
        assert.equal((await fetch(`${origin}/tasks/${randomUUID()}`)).status, 404);
        assert.equal(
            (await fetch(`${origin}/tasks/${taskId}/approve`, { method: "POST" })).status,
            404,
        );
    } finally {
        await runtime.closeRuntime();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("Phase 6 concurrent tasks isolate memory and traces and enforce capacity", async () => {
    let release;
    const ready = new Promise((resolve) => {
        release = resolve;
    });
    const model = createScriptedModel((index, messages) => {
        const last = messages.at(-1);
        if (last.name === "remember") return read;
        if (last.name === "db_query") return finish;
        return { name: "remember", args: { key: "task", value: messages[1].content } };
    });
    const { runtime, store, sessions } = testRuntime({
        model,
        resolveAccount: async () => {
            await ready;
            return { _id: account.userId, email: account.email };
        },
    });
    const tasks = await Promise.all(
        ["one", "two", "three", "four"].map((task) => runtime.startTask(task)),
    );
    await assert.rejects(runtime.startTask("five"), (error) => error.statusCode === 429);
    release();
    await Promise.all(tasks.map(({ taskId }) => waitTask(runtime, taskId)));
    for (const { taskId } of tasks) {
        const record = store.records.get(taskId);
        assert.equal(record.status, "done");
        assert.equal(record.memory.task, record.task);
        assert.equal(record.steps[0].sequence, 1);
    }
    assert.equal(sessions.size, 0);
    assert.equal(runtime.size, 0);
    await runtime.closeRuntime();
});

test("Phase 6 runtime retains approval checkpoints and sessions until shutdown", async () => {
    const { interrupt } = await import("@langchain/langgraph");
    const click = tool(
        async () => interrupt({ type: "approval", proposalId: "fixture-proposal" }),
        {
            name: "browser_click",
            description: "Testing-only pause probe",
            schema: z.object({ ref: z.number() }),
        },
    );
    const { runtime, store, sessions } = testRuntime({
        model: createScriptedModel([{ name: "browser_click", args: { ref: 1 } }], {
            taskKind: "action",
        }),
        createTools: () => registry([click]),
    });
    const task = await runtime.startTask("Pause for approval");
    await waitTask(runtime, task.taskId);
    const record = store.records.get(task.taskId);
    assert.equal(record.status, "awaiting_approval");
    assert.equal(record.pendingInterrupt.proposalId, "fixture-proposal");
    assert.equal(sessions.size, 1);
    assert.equal(record.steps.at(-1).summary.includes("no marked click"), true);
    await runtime.closeRuntime();
    assert.equal(record.status, "failed");
    assert.equal(sessions.size, 0);
});

test("Phase 6 structured interpretation rejects malformed output", async () => {
    const context = {
        model: { withStructuredOutput: () => ({ invoke: async () => ({ goal: "invalid" }) }) },
        registry: registry(),
        maxSteps: 5,
    };
    const graph = createAgentGraph({ getContext: () => context });
    await assert.rejects(
        graph.invoke(createInitialState(randomUUID(), "Read"), {
            configurable: { thread_id: randomUUID() },
        }),
    );
});

test("Phase 6 Gemini tool declarations adapt bounds while execution retains strict schemas", async () => {
    const { bindAgentTools } = await import("../src/agent/llm.js");
    const { browserSchemas } = await import("../src/agent/tools/browser.js");
    let declarations;
    const click = tool(async () => "unused", {
        name: "browser_click",
        description: "Click",
        schema: browserSchemas.browser_click,
    });
    bindAgentTools(
        {
            bindTools: (input) => {
                declarations = input;
            },
        },
        [click],
    );
    assert.equal(declarations[0].function.parameters.properties.ref.minimum, 1);
    assert.equal(JSON.stringify(declarations).includes("exclusiveMinimum"), false);
    assert.equal(browserSchemas.browser_click.safeParse({ ref: 0 }).success, false);
    assert.equal(browserSchemas.browser_click.safeParse({ ref: 1, extra: true }).success, false);
});

test("Phase 6 shutdown during run creation cannot launch new background work", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const store = memoryStore();
    const originalCreate = store.createRun;
    store.createRun = async (...args) => {
        await gate;
        return originalCreate(...args);
    };
    const { runtime, sessions } = testRuntime({ store });
    const starting = runtime.startTask("Read");
    const stopped = assert.rejects(starting, (error) => error.statusCode === 503);
    const closing = runtime.closeRuntime();
    release();
    await stopped;
    await closing;
    assert.equal(sessions.size, 0);
    assert.equal(runtime.size, 0);
    assert.equal([...store.records.values()][0].status, "failed");
});

test("Phase 6 daily quota exhaustion fails immediately instead of consuming transient retries", async () => {
    let attempts = 0;
    const model = {
        invoke: async () => {
            attempts += 1;
            throw Object.assign(new Error("private provider payload"), {
                status: 429,
                errorDetails: [
                    {
                        violations: [
                            { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" },
                        ],
                    },
                ],
            });
        },
    };
    await assert.rejects(invokeModel(model, [], { delay: async () => {} }));
    assert.equal(attempts, 1);
});

test("Phase 6 memory and message history remain bounded without orphan tool responses", async () => {
    const memories = Array.from({ length: 21 }, (_, index) => ({
        name: "remember",
        args: { key: `fact${index}`, value: "Observed fact" },
    }));
    const { state } = await runGraph([read, ...memories, finish], { maxSteps: 40 });
    assert.equal(state.status, "done");
    assert.equal(Object.keys(state.memory).length, 20);
    assert.equal(Object.hasOwn(state.memory, "fact20"), false);
    assert.equal(state.messages.length, 12);
    for (let index = 0; index < state.messages.length; index += 2)
        assert.equal(
            state.messages[index].tool_calls[0].id,
            state.messages[index + 1].tool_call_id,
        );
    await assert.rejects(createControlTools()[0].invoke({ key: "constructor", value: "bad" }));
});

test("Phase 6 rate limiter waits for the window, retry-after is honored and prose answers become finish", async () => {
    const { createRateLimiter, retryAfterMs, isMalformedToolCall, salvageFinishText } =
        await import("../src/agent/llm.js");
    let clock = 0;
    const waits = [];
    const limiter = createRateLimiter({
        maxPerMinute: 3,
        now: () => clock,
        sleep: async (milliseconds) => {
            waits.push(milliseconds);
            clock += milliseconds;
        },
    });
    for (let index = 0; index < 4; index += 1) await limiter.acquire();
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 60000);

    assert.equal(retryAfterMs({ headers: { "retry-after": "17" } }), 17000);
    assert.equal(retryAfterMs({ headers: new Headers({ "retry-after": "500" }) }), 20000);
    assert.equal(retryAfterMs({}), 0);

    const malformed = Object.assign(new Error("x"), {
        status: 400,
        error: {
            error: {
                code: "tool_use_failed",
                failed_generation: "The only bookable match is the ODI at INR 800 per ticket.",
            },
        },
    });
    assert.ok(isMalformedToolCall(malformed));
    assert.match(salvageFinishText(malformed), /ODI at INR 800/);
    const wrapped = Object.assign(new Error("x"), {
        error: {
            error: {
                failed_generation:
                    '{"name": "summary", "arguments": The only bookable match is the ODI.}',
            },
        },
    });
    assert.equal(salvageFinishText(wrapped), "The only bookable match is the ODI.");
    const other = Object.assign(new Error("x"), {
        error: {
            error: { failed_generation: '{"name": "db_query", "arguments": {broken json here}' },
        },
    });
    assert.equal(salvageFinishText(other), null);
    // Identical input gives an identical rejection at temperature 0, so this is not retried.
    let calls = 0;
    await assert.rejects(
        invokeModel(
            {
                invoke: async () => {
                    calls += 1;
                    throw malformed;
                },
            },
            [],
            { delay: async () => {} },
        ),
    );
    assert.equal(calls, 1);
    const delays = [];

    const limited = Object.assign(new Error("x"), { status: 429, headers: { "retry-after": "9" } });
    let tries = 0;
    await invokeModel(
        {
            invoke: async () => {
                tries += 1;
                if (tries === 1) throw limited;
                return "ok";
            },
        },
        [],
        { delay: async (ms) => delays.push(ms) },
    );
    assert.equal(delays.at(-1), 9000);
});

test("Phase 6 understanding defaults a missing taskKind to action", async () => {
    const { understand } = await import("../src/agent/nodes/understand.js");
    const model = {
        withStructuredOutput: () => ({
            invoke: async () => ({ goal: "g", successCriteria: ["c"], assumptions: [] }),
        }),
    };
    const result = await understand({ task: "t" }, { model, modelOptions: {} });
    assert.equal(result.taskKind, "action");
});
