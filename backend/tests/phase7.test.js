import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";
import { createRuntime } from "../src/agent/runtime.js";
import { createAgentApp } from "../src/agent/index.js";
import { selectAgentTools, compactReadEvidence } from "../src/agent/context.js";
import { getUnderstandPrompt } from "../src/agent/prompt.js";
import { runTool } from "../src/agent/nodes/tools.js";
import { createInitialState } from "../src/agent/state.js";
import { createControlTools } from "../src/agent/tools/control.js";
import { createScriptedModel } from "./helpers/phase6-model.js";
import { checkAction, cancellationDetails, checkExistingCancellation, createActionVerifier, describeAction } from "../src/agent/verification.js";

const account = { userId: "100000000000000000000001", email: "student@example.com" };
const finish = { name: "finish", args: { summary: "Observed facts." } };

function setup(calls, options = {}) {
    const records = new Map();
    const sessions = new Set();
    const store = {
        createRun: async (taskId, task) =>
            records.set(taskId, {
                taskId,
                task,
                status: "running",
                pendingInterrupt: null,
                steps: [],
            }),
        recordProgress: async (id, update) => {
            for (const key of ["status", "pendingInterrupt", "result"])
                if (key in update) records.get(id)[key] = update[key];
        },
        appendTrace: async (id, trace) => records.get(id).steps.push(trace),
        readRun: async (id) => records.get(id) ?? null,
        readTrace: async (id) => records.get(id) ?? null,
    };
    const runtime = createRuntime({
        config: { SITE_URL: "http://127.0.0.1:4000", STUDENT_EMAIL: account.email, MAX_STEPS: 15 },
        manager: {
            createSession: async (id) => sessions.add(id),
            closeSession: async (id) => sessions.delete(id),
            closeAll: async () => sessions.clear(),
        },
        store,
        resolveAccount: async () => ({ _id: account.userId, email: account.email }),
        model: createScriptedModel(calls, options),
        modelOptions: options.modelOptions,
        createTools: () => {
            const read = tool(
                async () =>
                    JSON.stringify({ success: true, records: [{ title: "Observed facts" }] }),
                { name: "db_query", description: "Fixture read", schema: z.object({}).strict() },
            );
            const tools = [...createControlTools(options.controlOptions), read, ...(options.tools ?? [])];
            return {
                tools,
                byName: new Map(tools.map((entry) => [entry.name, entry])),
                cancellationWorkflow: options.cancellationWorkflow,
                verifyActions: options.verifyActions,
                verifyExistingCancellation: options.verifyExistingCancellation,
            };
        },
    });
    return { runtime, records, sessions, store };
}

async function settle(runtime, id) {
    await runtime.getActiveTask(id)?.job;
}

test("Phase 7 questions resume the same browser/thread and retain ordered traces across pauses", async () => {
    const { runtime, records, sessions } = setup([
        { name: "ask_human", args: { question: "Which event?", choices: ["ODI", "T20"] } },
        { name: "ask_human", args: { question: "How many tickets?" } },
        { name: "db_query", args: {} },
        finish,
    ]);
    try {
        const { taskId } = await runtime.startTask("Find the event I mean");
        await settle(runtime, taskId);
        const entry = runtime.getActiveTask(taskId);
        assert.equal(records.get(taskId).status, "needs_input");
        assert.equal(sessions.size, 1);
        const first = records.get(taskId).pendingInterrupt;
        await assert.rejects(
            runtime.resumeTask(taskId, "approval", { proposalId: randomUUID(), approved: true }),
            { statusCode: 409 },
        );
        await assert.rejects(
            runtime.resumeTask(taskId, "input", { questionId: randomUUID(), answer: "ODI" }),
            { statusCode: 409 },
        );
        await runtime.resumeTask(taskId, "input", { questionId: first.questionId, answer: "ODI" });
        await settle(runtime, taskId);
        assert.equal(runtime.getActiveTask(taskId), entry);
        const second = records.get(taskId).pendingInterrupt;
        assert.notEqual(second.questionId, first.questionId);
        await assert.rejects(
            runtime.resumeTask(taskId, "input", { questionId: first.questionId, answer: "stale" }),
            { statusCode: 409 },
        );
        await runtime.resumeTask(taskId, "input", { questionId: second.questionId, answer: "2" });
        await settle(runtime, taskId);
        const record = records.get(taskId);
        assert.equal(record.status, "done");
        assert.equal(record.pendingInterrupt, null);
        assert.deepEqual(entry.state.clarifications, [
            { question: "Which event?", answer: "ODI" },
            { question: "How many tickets?", answer: "2" },
        ]);
        assert.equal(record.steps.filter((step) => step.node === "understand").length, 1);
        assert.deepEqual(
            record.steps.map((step) => step.sequence),
            record.steps.map((_, index) => index + 1),
        );
        assert.equal(sessions.size, 0);
        assert.equal(runtime.size, 0);
        await assert.rejects(
            runtime.resumeTask(taskId, "input", {
                questionId: second.questionId,
                answer: "replay",
            }),
            { statusCode: 409 },
        );
    } finally {
        await runtime.closeRuntime();
    }
});

test("Phase 7 locks simultaneous resumes before persistence and rolls back failed resume persistence", async () => {
    const { runtime, store, records } = setup([
        { name: "ask_human", args: { question: "Which event?" } },
        { name: "db_query", args: {} },
        finish,
    ]);
    try {
        const { taskId } = await runtime.startTask("Find event");
        await settle(runtime, taskId);
        const response = {
            questionId: records.get(taskId).pendingInterrupt.questionId,
            answer: "ODI",
        };
        const save = store.recordProgress;
        let release;
        let blockResume = true;
        store.recordProgress = async (id, update) => {
            if (blockResume && update.status === "running" && update.pendingInterrupt === null) {
                blockResume = false;
                await new Promise((resolve) => {
                    release = resolve;
                });
            }
            return save(id, update);
        };
        const accepted = runtime.resumeTask(taskId, "input", response);
        await assert.rejects(runtime.resumeTask(taskId, "input", response), { statusCode: 409 });
        release();
        await accepted;
        await settle(runtime, taskId);
        assert.equal(records.get(taskId).status, "done");
    } finally {
        await runtime.closeRuntime();
    }

    const broken = setup([{ name: "ask_human", args: { question: "Which event?" } }]);
    try {
        const { taskId } = await broken.runtime.startTask("Find event");
        await settle(broken.runtime, taskId);
        broken.store.recordProgress = async () => {
            throw new Error("fixture persistence failure");
        };
        await assert.rejects(
            broken.runtime.resumeTask(taskId, "input", {
                questionId: broken.records.get(taskId).pendingInterrupt.questionId,
                answer: "ODI",
            }),
            { statusCode: 503 },
        );
        assert.equal(broken.runtime.getActiveTask(taskId).paused, true);
    } finally {
        broken.store.recordProgress = async () => {};
        await broken.runtime.closeRuntime();
    }
});

test("Phase 7 approve/reject routes enforce bodies, interrupt type and at most one action", async () => {
    for (const approved of [true, false]) {
        let writes = 0;
        const proposal = { type: "approval", proposalId: randomUUID(), action: "Confirm booking" };
        const action = tool(
            async () => {
                const answer = interrupt(proposal);
                if (!answer.approved)
                    return JSON.stringify({
                        success: false,
                        observation: "Action rejected. No action executed.",
                    });
                writes++;
                return JSON.stringify({ success: true, approvedAction: true });
            },
            {
                name: "browser_click",
                description: "Fixture action gate",
                schema: z.object({ ref: z.number() }),
            },
        );
        const { runtime, records } = setup([{ name: "browser_click", args: { ref: 1 } }, finish], {
            taskKind: "action",
            tools: [action],
            verifyActions: async () => ({ success: true, actions: [], checks: [] }),
        });
        const server = createAgentApp(() => runtime).listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const post = (path, body) =>
            fetch(`${origin}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        try {
            const { taskId } = await runtime.startTask("Book one ticket");
            await settle(runtime, taskId);
            assert.equal(writes, 0);
            assert.equal(records.get(taskId).status, "awaiting_approval");
            assert.equal(
                (await post(`/tasks/${taskId}/answer`, { questionId: randomUUID(), answer: "yes" }))
                    .status,
                409,
            );
            assert.equal(
                (
                    await post(`/tasks/${taskId}/approve`, {
                        proposalId: proposal.proposalId,
                        approved: true,
                    })
                ).status,
                400,
            );
            assert.equal(
                (await post(`/tasks/${taskId}/approve`, { proposalId: randomUUID() })).status,
                409,
            );
            const path = `/tasks/${taskId}/${approved ? "approve" : "reject"}`;
            assert.equal((await post(path, { proposalId: proposal.proposalId })).status, 202);
            await settle(runtime, taskId);
            assert.equal(writes, approved ? 1 : 0);
            assert.equal(records.get(taskId).status, approved ? "done" : "failed");
            assert.equal((await post(path, { proposalId: proposal.proposalId })).status, 409);
            assert.equal(
                (await post(`/tasks/${randomUUID()}/approve`, { proposalId: proposal.proposalId }))
                    .status,
                404,
            );
        } finally {
            await runtime.closeRuntime();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    }
});

test("Phase 7 shutdown during resume persistence cannot launch continuation", async () => {
    const { runtime, records, store, sessions } = setup([
        { name: "ask_human", args: { question: "Which event?" } },
        { name: "db_query", args: {} },
        finish,
    ]);
    const { taskId } = await runtime.startTask("Find event");
    await settle(runtime, taskId);
    const save = store.recordProgress;
    let release;
    let block = true;
    store.recordProgress = async (id, update) => {
        if (block && update.status === "running") {
            block = false;
            await new Promise((resolve) => {
                release = resolve;
            });
        }
        return save(id, update);
    };
    const resumed = runtime.resumeTask(taskId, "input", {
        questionId: records.get(taskId).pendingInterrupt.questionId,
        answer: "ODI",
    });
    const stopped = runtime.closeRuntime();
    const rejected = assert.rejects(resumed, { statusCode: 503 });
    release();
    await Promise.all([stopped, rejected]);
    assert.equal(records.get(taskId).status, "failed");
    assert.equal(runtime.size, 0);
    assert.equal(sessions.size, 0);
});

test("Phase 7 database checks cover cancellation, waitlist and profile outcomes", () => {
    const { before: empty, after: booked } = bookingWorld();
    const before = structuredClone(booked);
    before.bookings[0].refundAmount = 0;
    before.bookings[0].cancelledAt = null;
    const cancelled = structuredClone(before);
    cancelled.bookings[0].status = "cancelled";
    cancelled.bookings[0].refundAmount = 1600;
    cancelled.bookings[0].cancelledAt = "2026-10-10T08:30:00.000Z";
    cancelled.matches[0].sold -= 2;
    cancelled.outbox.push({
        _id: "cancel-receipt",
        to: account.email,
        type: "cancellation",
        relatedBookingId: before.bookings[0]._id,
        subject: "Booking cancelled: MD-TEST",
        body: "MD-TEST: ODI cancelled. Refund INR 1600.",
    });
    const cancel = {
        kind: "cancel",
        matchId: before.matches[0]._id,
        bookingId: before.bookings[0]._id,
        quantity: 2,
        refund: 1600,
    };
    assert.equal(checkAction(before, cancelled, cancel, account).success, true);
    cancelled.bookings[0].refundAmount = 0;
    assert.equal(checkAction(before, cancelled, cancel, account).success, false);

    const queued = structuredClone(empty);
    queued.waitlist.push({
        _id: "queue",
        userId: account.userId,
        matchId: empty.matches[0]._id,
        quantity: 2,
        position: 1,
        createdAt: "2026-10-10T08:30:00.000Z",
    });
    queued.outbox.push({
        _id: "queue-receipt",
        type: "waitlist_joined",
        to: account.email,
        subject: "Waitlist joined: ODI",
        body: "ODI: 2 ticket(s) requested. Your waitlist position is 1.",
    });
    const wait = {
        kind: "waitlist",
        matchId: empty.matches[0]._id,
        title: "ODI",
        quantity: 2,
        expectedPosition: 1,
    };
    assert.equal(checkAction(empty, queued, wait, account).success, true);
    queued.waitlist[0].position = 9;
    assert.equal(checkAction(empty, queued, wait, account).success, false);

    const edited = structuredClone(empty);
    edited.user.name = "New Student";
    assert.equal(
        checkAction(
            empty,
            edited,
            { kind: "profile", name: "New Student", phone: edited.user.phone },
            account,
        ).success,
        true,
    );
    edited.user.email = "other@example.com";
    assert.equal(
        checkAction(
            empty,
            edited,
            { kind: "profile", name: "New Student", phone: edited.user.phone },
            account,
        ).success,
        false,
    );
});

function bookingWorld() {
    const matchId = "200000000000000000000003";
    const before = {
        user: {
            _id: account.userId,
            name: "Student",
            email: account.email,
            phone: "+919000000001",
        },
        now: "2026-10-10T14:00:00+05:30",
        matches: [
            {
                _id: matchId,
                title: "ODI",
                price: 800,
                sold: 18,
                startsAt: "2026-10-12T08:30:00Z",
                endsAt: "2026-10-12T16:30:00Z",
                refundFullHoursBefore: 24,
            },
        ],
        bookings: [],
        waitlist: [],
        outbox: [],
    };
    const action = {
        kind: "book",
        matchId,
        title: "ODI",
        quantity: 2,
        total: 1600,
        ownerName: "Student",
        ownerEmail: account.email,
    };
    const after = structuredClone(before);
    after.matches[0].sold += 2;
    after.bookings.push({
        _id: "300000000000000000000003",
        code: "MD-TEST",
        matchId,
        userId: account.userId,
        ownerName: "Student",
        ownerEmail: account.email,
        quantity: 2,
        totalPrice: 1600,
        status: "booked",
        createdAt: "2026-10-10T08:30:00.000Z",
    });
    after.outbox.push({
        _id: "400000000000000000000003",
        relatedBookingId: after.bookings[0]._id,
        to: account.email,
        type: "booking_confirmation",
        subject: "Booking confirmed: MD-TEST",
        body: "MD-TEST: 2 ticket(s) for ODI. Total INR 1600.",
    });
    return { before, after, action };
}

test("Phase 7 independent action checks reject missing receipts, wrong outcomes and extra mutations", () => {
    const { before, after, action } = bookingWorld();
    assert.equal(checkAction(before, after, action, account).success, true);
    for (const change of [
        (world) => {
            world.outbox = [];
        },
        (world) => {
            world.matches[0].sold++;
        },
        (world) => {
            world.bookings[0].quantity = 3;
        },
        (world) => {
            world.bookings.push({ ...world.bookings[0], _id: "extra" });
        },
        (world) => {
            world.user.name = "Unexpected edit";
        },
    ]) {
        const wrong = structuredClone(after);
        change(wrong);
        assert.equal(checkAction(before, wrong, action, account).success, false);
    }
    assert.equal(
        checkAction(before, before, action, account).success,
        false,
        "A success banner without records is not success",
    );
});

test("Phase 7 baseline capture is stable and changed database state blocks approval", async () => {
    const { before, after } = bookingWorld();
    let world = before;
    let reads = 0;
    const verifier = createActionVerifier(account, {
        readState: async () => {
            reads++;
            return structuredClone(world);
        },
    });
    const details = {
        destination: "http://127.0.0.1:4000/matches/200000000000000000000003/book",
        method: "post",
        values: [
            ["quantity", "2"],
            ["ownerName", "Student"],
            ["ownerEmail", account.email],
        ],
    };
    const proposalId = randomUUID();
    assert.equal((await verifier.capture(proposalId, details)).total, 1600);
    await verifier.capture(proposalId, details);
    assert.equal(reads, 1);
    assert.equal((await verifier.verifyActions()).success, false);
    world = after;
    await assert.rejects(verifier.approve(proposalId), /proposal changed/);
    world = before;
    await verifier.approve(proposalId);
    world = after;
    assert.equal((await verifier.verifyActions()).success, true);
    await assert.rejects(verifier.capture(randomUUID(), details), /one persisted action/);
    assert.throws(() =>
        describeAction({ ...details, destination: "http://127.0.0.1:4000/admin/clock" }, before),
    );
});

test("Phase 7 verification failure and unsupported goal never return done", async () => {
    for (const options of [
        { verifyActions: async () => ({ success: false, checks: [], actions: [] }) },
        {
            verifyMet: false,
            verifyActions: async () => ({ success: true, checks: [], actions: [] }),
        },
    ]) {
        const { runtime, records } = setup([finish], { taskKind: "action", ...options });
        try {
            const { taskId } = await runtime.startTask("Book ticket");
            await settle(runtime, taskId);
            assert.equal(records.get(taskId).status, "failed");
            assert.ok(records.get(taskId).steps.some((step) => step.node === "verify"));
        } finally {
            await runtime.closeRuntime();
        }
    }
});

test("Phase 7 explicit stopped-action signals prevent any further model action", async () => {
    let calls = 0;
    const action = tool(
        async () =>
            JSON.stringify({
                success: false,
                actionStopped: true,
                observation: "Action details changed. A fresh proposal and approval are required.",
            }),
        {
            name: "browser_click",
            description: "Fixture changed-action outcome",
            schema: z.object({ ref: z.number() }),
        },
    );
    const { runtime, records } = setup(
        () => {
            calls++;
            return { name: "browser_click", args: { ref: 1 } };
        },
        { taskKind: "action", tools: [action] },
    );
    try {
        const { taskId } = await runtime.startTask("Book ticket");
        await settle(runtime, taskId);
        assert.equal(records.get(taskId).status, "failed");
        assert.equal(calls, 1);
        assert.equal(records.get(taskId).steps.filter((entry) => entry.node === "tools").length, 1);
    } finally {
        await runtime.closeRuntime();
    }
});

// Regression coverage for user-approved changes to task requirements.
test("requirement revisions need explicit acceptance and retain unrelated criteria", async () => {
    for (const answer of ["Book 2", "Keep 3", "Yes, but another event"]) {
        const revision = { reason: "Only two remain", acceptChoice: "Book 2",
            changes: [{ previous: "Book 3", replacement: "Book 2" }] };
        const { runtime, records } = setup([
            { name: "ask_human", args: { question: "Book 2 instead of 3?",
                choices: ["Book 2", "Keep 3"], revision } },
            { name: "db_query", args: {} }, finish,
        ], { successCriteria: ["Book 3", "Approval before submission"] });
        try {
            const { taskId } = await runtime.startTask("Book 3; ask before changing quantity");
            await settle(runtime, taskId);
            const entry = runtime.getActiveTask(taskId);
            const pending = records.get(taskId).pendingInterrupt;
            assert.deepEqual(pending.revision, revision);
            await runtime.resumeTask(taskId, "input", { questionId: pending.questionId, answer });
            await settle(runtime, taskId);
            const accepted = answer === "Book 2";
            assert.deepEqual(entry.state.successCriteria, [accepted ? "Book 2" : "Book 3", "Approval before submission"]);
            assert.equal(entry.state.task, "Book 3; ask before changing quantity");
            assert.equal(entry.state.hasAction, false);
            assert.equal(entry.state.clarifications[0].accepted, accepted);
            assert.equal(entry.state.llmCallCount, 5);
            if (accepted) assert.match(records.get(taskId).result.summary, /Agreed changes/);
        } finally { await runtime.closeRuntime(); }
    }
});

test("requirement revisions reject stale criteria and changes after submission", async () => {
    for (const hasAction of [false, true]) {
        let invoked = false;
        const state = { ...createInitialState("test", "Book 3"), hasAction,
            successCriteria: ["Book 3"], pendingTool: { id: "revision", name: "ask_human", args: {
                revision: { changes: [{ previous: hasAction ? "Book 3" : "Stale", replacement: "Book 2" }] },
            } } };
        const update = await runTool(state, { registry: { byName: new Map([
            ["ask_human", { invoke: async () => { invoked = true; } }],
        ]) } });
        assert.equal(invoked, false);
        assert.equal(update.lastObservation.success, false);
        assert.equal(update.successCriteria, undefined);
    }
});

test("completion still requires all current criteria and independent verification", async () => {
    for (const [verified, met, failure] of [[true, true, false], [false, true, true], [true, false, true]]) {
        const state = { ...createInitialState("test", "Book 3"), hasAction: true,
            successCriteria: ["Book 2"], verification: { success: verified },
            pendingTool: { id: "finish", name: "finish", args: {
                summary: "Booked 2 as agreed", criteria: [{ criterion: "Book 2", met }],
            } } };
        const tools = createControlTools();
        const update = await runTool(state, { registry: { byName: new Map(tools.map((entry) => [entry.name, entry])) } });
        assert.equal(Boolean(update.failure), failure);
    }
});

function cancelledWorld() {
    return {
        now: "2026-10-10T14:00:00+05:30",
        bookings: [{ _id: "booking", code: "MD-1001", userId: account.userId,
            matchId: "match", status: "cancelled", totalPrice: 1000, refundAmount: 1000,
            cancelledAt: "2026-10-10T08:30:00.000Z" }],
        matches: [{ _id: "match", title: "Rovers vs Eastgate",
            startsAt: "2026-10-13T13:30:00.000Z", refundFullHoursBefore: 24 }],
        outbox: [{ relatedBookingId: "booking", type: "cancellation", to: account.email,
            body: "MD-1001 cancelled. Refund INR 1000." }],
    };
}

const cancellationTask = "Cancel my booking MD-1001 for Rovers vs Eastgate. Tell me the refund based on site time.";

test("existing cancellation verification distinguishes recorded and current-time refunds", () => {
    const state = cancelledWorld();
    let evidence = checkExistingCancellation(state, cancellationTask, "MD-1001", account);
    assert.equal(evidence.success, true);
    assert.equal(evidence.currentPolicyRefund, 1000);
    assert.deepEqual(evidence.actions, []);
    assert.match(evidence.summary, /already cancelled/);
    state.now = "2026-10-13T13:00:00.000Z";
    evidence = checkExistingCancellation(state, cancellationTask, "MD-1001", account);
    assert.equal(evidence.success, true);
    assert.equal(evidence.currentPolicyRefund, 0);
    assert.match(evidence.summary, /Recorded refund INR 1000/);
    assert.match(evidence.summary, /No new cancellation or refund/);
});

test("existing cancellation verification rejects wrong targets and unsupported evidence", () => {
    for (const mutate of [
        (state) => { state.bookings[0].status = "booked"; },
        (state) => { state.bookings[0].userId = "another-user"; },
        (state) => { state.matches[0].title = "Another event"; },
        (state) => { state.outbox = []; },
        (state) => { state.bookings[0].refundAmount = 0; },
        (state) => { state.now = "invalid"; },
        (state) => { state.bookings.push({ ...state.bookings[0] }); },
    ]) {
        const state = cancelledWorld();
        mutate(state);
        assert.equal(checkExistingCancellation(state, cancellationTask, "MD-1001", account).success, false);
    }
    for (const task of ["View MD-1001 for Rovers vs Eastgate", "Cancel MD-9999 for Rovers vs Eastgate",
        "Cancel MD-1001 and MD-1002 for Rovers vs Eastgate"])
        assert.equal(checkExistingCancellation(cancelledWorld(), task, "MD-1001", account).success, false);
});

test("already-cancelled action task finishes without a submission or extra model call", async () => {
    let checks = 0;
    const { runtime, records } = setup([
        { name: "db_query", args: {} },
        { name: "finish", args: {
            summary: "Existing cancellation", criteria: [{ criterion: "Cancel requested booking and report refund", met: true }],
            alreadySatisfied: { kind: "cancel", bookingCode: "MD-1001" },
        } },
    ], { taskKind: "action", successCriteria: ["Cancel requested booking and report refund"],
        verifyExistingCancellation: async (task, code) => {
            checks++;
            return checkExistingCancellation(cancelledWorld(), task, code, account);
        } });
    try {
        const { taskId } = await runtime.startTask(cancellationTask);
        const entry = runtime.getActiveTask(taskId);
        await settle(runtime, taskId);
        assert.equal(records.get(taskId).status, "done");
        assert.match(records.get(taskId).result.summary, /Recorded refund INR 1000/);
        assert.equal(records.get(taskId).result.evidence.outcome, "already_satisfied");
        assert.equal(entry.state.hasAction, false);
        assert.equal(entry.state.llmCallCount, 4);
        assert.equal(checks, 1);
    } finally { await runtime.closeRuntime(); }
});

test("alternating unchanged DB reads retain evidence and restrict further discovery", async () => {
    let state = createInitialState("loop", cancellationTask);
    const registry = { tools: ["db_query", "browser_goto", "finish", "ask_human"].map((name) => ({ name })),
        byName: new Map([["db_query", { invoke: async (args) => ({ success: true,
            records: [{ _id: args.collection, status: "cancelled" }] }) }]]) };
    for (const collection of ["bookings", "matches", "outbox", "bookings", "matches", "outbox"]) {
        state.pendingTool = { id: collection, name: "db_query", args: { collection, filter: "{}" } };
        state = { ...state, ...await runTool(state, { registry }) };
    }
    assert.equal(state.readEvidence.length, 3);
    assert.equal(state.unchangedReadCount, 3);
    assert.deepEqual(selectAgentTools(state, registry).map((entry) => entry.name), ["finish", "ask_human"]);
    assert.match(compactReadEvidence(state.readEvidence), /cancelled/);
    assert.ok(compactReadEvidence(state.readEvidence).length < 4600);
    assert.match(getUnderstandPrompt(), /Do not invent a separate cancellation reference/);
    registry.byName.set("db_query", { invoke: async () => ({ success: true, records: [{ status: "changed" }] }) });
    state = { ...state, ...await runTool(state, { registry }) };
    assert.equal(state.unchangedReadCount, 0);
    assert.ok(selectAgentTools(state, registry).some((entry) => entry.name === "db_query"));
});


test("already-satisfied finish cannot bypass unmet criteria or missing action evidence", async () => {
    for (const hasAction of [false, true]) {
        let checked = false;
        const tools = createControlTools();
        const registry = { byName: new Map(tools.map((entry) => [entry.name, entry])),
            verifyExistingCancellation: async (task, code) => {
                checked = true;
                return checkExistingCancellation(cancelledWorld(), task, code, account);
            } };
        const state = { ...createInitialState("test", cancellationTask), hasAction,
            successCriteria: ["Requested cancellation and refund"],
            pendingTool: { id: "finish", name: "finish", args: {
                summary: "Already cancelled", alreadySatisfied: { kind: "cancel", bookingCode: "MD-1001" },
                criteria: [{ criterion: "Requested cancellation and refund", met: false }],
            } } };
        const update = await runTool(state, { registry });
        assert.ok(update.failure);
        assert.equal(checked, !hasAction);
    }
});


function londonWorld() {
    const state = bookingWorld().after;
    state.matches[0] = { ...state.matches[0], title: "London tennis semi-final",
        startsAt: "2026-10-11T08:30:00.000Z", endsAt: "2026-10-11T11:30:00.000Z",
        policyText: "Full refund until 24 hours before play", price: 700 };
    state.bookings[0].totalPrice = 1400;
    return state;
}

test("cancellation quote uses INR for London and the exact site refund boundary", () => {
    const state = londonWorld();
    const selection = { eventSearch: "london tennis semi final" };
    let quote = cancellationDetails(state, selection, account);
    assert.equal(quote.status, "ready");
    assert.equal(quote.refund, 1400);
    assert.equal(quote.currency, "INR");
    assert.match(quote.summary, /INR 1400/);
    assert.doesNotMatch(quote.summary, /£/);
    state.now = "2026-10-10T08:30:00.001Z";
    assert.equal(cancellationDetails(state, selection, account).refund, 0);
    state.matches[0].refundFullHoursBefore = null;
    assert.equal(cancellationDetails(state, selection, account).refund, 0);
    state.now = "invalid";
    assert.throws(() => cancellationDetails(state, selection, account), /site time/);
});

test("cancellation quote ignores cancelled records and requires choosing multiple active bookings", () => {
    const state = londonWorld();
    state.bookings.push({ ...state.bookings[0], _id: "old", code: "MD-OLD", status: "cancelled" });
    assert.equal(cancellationDetails(state, { eventSearch: "London tennis" }, account).status, "ready");
    state.bookings.push({ ...state.bookings[0], _id: "other", code: "MD-OTHER" });
    const quote = cancellationDetails(state, { eventSearch: "London tennis" }, account);
    assert.equal(quote.status, "ambiguous");
    assert.equal(quote.candidates.length, 2);
    assert.equal(cancellationDetails(state, { bookingCode: "MD-OTHER" }, account).bookingId, "other");
    assert.equal(cancellationDetails(state, { bookingCode: "MD-OLD" }, account).status, "already_cancelled");
});

test("cancellation tools require a quote first and prohibit repeated conversational confirmation", async () => {
    const controls = createControlTools({ prepareCancellation: async () => ({}), canAskHuman: () => false });
    const registry = { tools: controls, cancellationWorkflow: true };
    const state = createInitialState("cancel", "Cancel London tennis");
    assert.deepEqual(selectAgentTools(state, registry).map((entry) => entry.name), ["prepare_cancellation"]);
    state.cancellationQuote = { status: "ready" };
    assert.ok(!selectAgentTools(state, registry).some((entry) => entry.name === "ask_human"));
    const result = JSON.parse(await controls.find((entry) => entry.name === "ask_human")
        .invoke({ question: "Are you sure?", choices: ["Yes", "No"] }));
    assert.equal(result.success, false);
    assert.match(result.observation, /request_approval/);
});

test("cancellation approval rejects missing, changed and wrong-booking quotes", async () => {
    let world = londonWorld();
    const verifier = createActionVerifier(account, { cancellationOnly: true,
        readState: async () => structuredClone(world) });
    const details = { method: "post", destination: `http://localhost:4000/bookings/${world.bookings[0]._id}/cancel`, values: [] };
    await assert.rejects(verifier.capture(randomUUID(), details), /not prepared/);
    await verifier.prepareCancellation({ eventSearch: "London tennis semi final" });
    const proposal = randomUUID();
    const action = await verifier.capture(proposal, details);
    assert.equal(action.refund, 1400);
    assert.equal(action.currency, "INR");
    assert.equal(action.bookingCode, "MD-TEST");
    world.now = "2026-10-10T08:30:00.001Z";
    await assert.rejects(verifier.approve(proposal), /proposal changed/);
    await assert.rejects(verifier.capture(randomUUID(), details), /details changed/);
    world = londonWorld();
    world.bookings.push({ ...world.bookings[0], _id: "300000000000000000000004", code: "MD-OTHER" });
    await assert.rejects(verifier.capture(randomUUID(), { ...details,
        destination: "http://localhost:4000/bookings/300000000000000000000004/cancel" }), /details changed/);
});

test("ambiguous cancellation cannot silently select a booking without the user's answer", async () => {
    let invoked = false;
    let state = { ...createInitialState("test", "Cancel London tennis"),
        cancellationQuote: { status: "ambiguous", candidates: [{ bookingCode: "MD-ONE" }, { bookingCode: "MD-TWO" }] },
        pendingTool: { name: "prepare_cancellation", id: "prepare", args: { bookingCode: "MD-ONE" } } };
    const registry = { byName: new Map([["prepare_cancellation", { invoke: async () => {
        invoked = true; return { success: true, cancellationQuote: { status: "ready" } };
    } }]]) };
    let update = await runTool(state, { registry });
    assert.equal(invoked, false);
    assert.match(update.lastObservation.observation, /select an exact booking code/);
    state.clarifications = [{ question: "Which booking?", answer: "MD-ONE" }];
    update = await runTool(state, { registry });
    assert.equal(invoked, true);
    assert.equal(update.cancellationQuote.status, "ready");
});


test("cancellation workflow approves once and never replays submission after provider rate limits", async () => {
    for (const outcome of ["normal", "rate_before", "rate_after"]) {
        let world = londonWorld();
        let submissions = 0;
        let proposal;
        const verifier = createActionVerifier(account, { cancellationOnly: true,
            readState: async () => structuredClone(world) });
        const criteria = ["Approved cancellation and refund reported"];
        const calls = (index) => {
            if (outcome === "rate_before" || outcome === "rate_after" && index === 2)
                throw Object.assign(new Error("private provider text"), { status: 429 });
            return [
                { name: "prepare_cancellation", args: { eventSearch: "London tennis semi final" } },
                { name: "request_approval", args: { ref: 1 } },
                { name: "finish", args: { summary: "Cancellation verified",
                    criteria: [{ criterion: criteria[0], met: true }] } },
            ][index];
        };
        const { runtime, records } = setup(calls, {
            taskKind: "action", successCriteria: criteria, cancellationWorkflow: true,
            modelOptions: { attempts: 1 }, verifyActions: verifier.verifyActions,
            controlOptions: {
                prepareCancellation: verifier.prepareCancellation,
                canAskHuman: () => verifier.getCancellationQuote()?.status !== "ready",
                requestAction: async () => {
                    if (!proposal) {
                        proposal = { type: "approval", proposalId: randomUUID() };
                        proposal.details = await verifier.capture(proposal.proposalId, { method: "post",
                            destination: `http://localhost:4000/bookings/${world.bookings[0]._id}/cancel`, values: [] });
                    }
                    const answer = interrupt(proposal);
                    assert.equal(answer.approved, true);
                    await verifier.approve(proposal.proposalId);
                    submissions++;
                    world.bookings[0] = { ...world.bookings[0], status: "cancelled",
                        refundAmount: 1400, cancelledAt: new Date(world.now).toISOString() };
                    world.matches[0].sold -= 2;
                    world.outbox.push({ _id: "cancel-receipt", relatedBookingId: world.bookings[0]._id,
                        to: account.email, type: "cancellation", subject: "Booking cancelled: MD-TEST",
                        body: "MD-TEST cancelled. Refund INR 1400." });
                    return { success: true, approvedAction: true };
                },
            },
        });
        try {
            const { taskId } = await runtime.startTask("Cancel my booking for London tennis semi final; show refund before confirmation.");
            await settle(runtime, taskId);
            if (outcome !== "rate_before") {
                const pending = records.get(taskId).pendingInterrupt;
                assert.equal(records.get(taskId).status, "awaiting_approval");
                assert.equal(pending.details.refund, 1400);
                assert.equal(pending.details.currency, "INR");
                assert.equal(submissions, 0);
                await runtime.resumeTask(taskId, "approval", { proposalId: pending.proposalId, approved: true });
                await settle(runtime, taskId);
                assert.equal(submissions, 1);
            }
            const result = records.get(taskId).result;
            if (outcome === "normal") {
                assert.equal(result.success, true);
                assert.match(result.summary, /Refund INR 1400/);
            } else {
                assert.equal(result.providerStatus, 429);
                assert.equal(result.submissionStatus, outcome === "rate_after" ? "verified" : "not_submitted");
                assert.doesNotMatch(result.summary, /private provider/);
            }
            assert.equal(records.get(taskId).steps.filter((entry) => entry.status === "awaiting_approval").length,
                outcome === "rate_before" ? 0 : 1);
        } finally { await runtime.closeRuntime(); }
    }
});


// Typo-tolerant discovery must still resolve exact owned IDs before completion.
test("fuzzy cancellation resolves missing letters and punctuation while preferring active tickets", () => {
    const state = londonWorld();
    state.bookings.push({ ...state.bookings[0], _id: "old", code: "MD-OLD", status: "cancelled" });
    const target = cancellationDetails(state, { eventSearch: "london tenis semi final" }, account);
    assert.equal(target.status, "ready");
    assert.equal(target.bookingId, state.bookings[0]._id);
    assert.equal(target.matchId, state.matches[0]._id);
    assert.equal(target.bookingCode, "MD-TEST");
});

test("fuzzy cancellation verifies resolved IDs without requiring a code in the original task", async () => {
    const state = cancelledWorld();
    state.matches[0].title = "London tennis semi-final";
    const task = "Cancel my booking for london tenis semi final";
    const verifier = createActionVerifier(account, { task, readState: async () => structuredClone(state) });
    assert.equal((await verifier.verifyExistingCancellation(task, "MD-1001")).success, false);
    const target = await verifier.prepareCancellation({ eventSearch: "london tenis semi final" });
    assert.equal(target.status, "already_cancelled");
    assert.equal((await verifier.verifyExistingCancellation(task, target.bookingCode)).success, true);
    assert.equal((await verifier.verifyExistingCancellation(task, "MD-WRONG")).success, false);
    state.bookings.push({ ...state.bookings[0], _id: "new", code: "MD-NEW", status: "booked" });
    assert.equal((await verifier.verifyExistingCancellation(task, target.bookingCode)).success, false);
});

test("fuzzy cancellation ambiguity requires an explicit user choice before binding a code", async () => {
    const state = londonWorld();
    state.bookings.push({ ...state.bookings[0], _id: "other", code: "MD-OTHER" });
    const task = "Cancel my booking for london tenis semi final";
    const verifier = createActionVerifier(account, { task, readState: async () => structuredClone(state) });
    const target = await verifier.prepareCancellation({ eventSearch: "london tenis semi final" });
    assert.equal(target.status, "ambiguous");
    await assert.rejects(verifier.prepareCancellation({ bookingCode: "MD-OTHER" }), /user's choice/);
    verifier.acceptCancellationChoice("MD-OTHER", target.candidates.map((row) => row.bookingCode));
    const selected = await verifier.prepareCancellation({ bookingCode: "MD-OTHER" });
    assert.equal(selected.status, "ready");
    assert.equal(selected.bookingId, "other");
});


test("verified new cancellation ignores an erroneous alreadySatisfied completion flag", async () => {
    const tools = createControlTools();
    const registry = { byName: new Map(tools.map((entry) => [entry.name, entry])),
        verifyExistingCancellation: async () => { throw new Error("Existing-state path must not run"); } };
    for (const verified of [true, false]) {
        const state = { ...createInitialState("finish", cancellationTask), hasAction: true,
            verification: { success: verified }, successCriteria: ["Cancellation verified"],
            pendingTool: { id: "finish", name: "finish", args: {
                summary: "Cancelled booking; refund INR 1000.",
                criteria: [{ criterion: "Cancellation verified", met: true }],
                alreadySatisfied: { kind: "cancel", bookingCode: "MD-1001" },
            } } };
        const update = await runTool(state, { registry });
        assert.equal(Boolean(update.failure), !verified);
        assert.equal(update.finishSummary, "Cancelled booking; refund INR 1000.");
        assert.equal(update.verification, undefined);
    }
});
