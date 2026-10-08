import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";
import { createRuntime } from "../src/agent/runtime.js";
import { createAgentApp } from "../src/agent/index.js";
import { createControlTools } from "../src/agent/tools/control.js";
import { createScriptedModel } from "./helpers/phase6-model.js";
import { checkAction, createActionVerifier, describeAction } from "../src/agent/verification.js";

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
        createTools: () => {
            const read = tool(
                async () =>
                    JSON.stringify({ success: true, records: [{ title: "Observed facts" }] }),
                { name: "db_query", description: "Fixture read", schema: z.object({}).strict() },
            );
            const tools = [...createControlTools(), read, ...(options.tools ?? [])];
            return {
                tools,
                byName: new Map(tools.map((entry) => [entry.name, entry])),
                verifyActions: options.verifyActions,
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
