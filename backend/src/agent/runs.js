import { AgentRun } from "../site/models/index.js";

export function createRun(taskId, task) {
    return AgentRun.create({ taskId, task, status: "running" });
}

export function recordProgress(taskId, update) {
    const allowed = [
        "status",
        "goal",
        "successCriteria",
        "plan",
        "memory",
        "pendingInterrupt",
        "result",
    ];
    const values = Object.fromEntries(
        Object.entries(update).filter(([key]) => allowed.includes(key)),
    );

    return AgentRun.updateOne({ taskId }, { $set: values }).exec();
}

export function appendTrace(taskId, entry) {
    // Preserve JSON shape; replace excessively large observations with a clear size note.
    const bounded = { ...entry };
    if (JSON.stringify(bounded.observation ?? null).length > 28000)
        bounded.observation = {
            observation:
                "Large observation omitted from trace; narrow the query or inspect task evidence.",
        };

    return AgentRun.updateOne({ taskId }, { $push: { steps: bounded } }).exec();
}

export function readRun(taskId) {
    return AgentRun.findOne({ taskId }).select("-steps -__v").lean().exec();
}

export async function readTrace(taskId) {
    const record = await AgentRun.findOne({ taskId }).select("taskId status steps").lean().exec();
    return record ?? null;
}

export function recoverRuns() {
    return AgentRun.updateMany(
        { status: { $in: ["running", "awaiting_approval", "needs_input"] } },
        {
            $set: {
                status: "failed",
                pendingInterrupt: null,
                result: {
                    success: false,
                    summary:
                        "Agent restarted; browser and in-memory checkpoints cannot be restored. Start a new task.",
                },
            },
        },
    ).exec();
}
