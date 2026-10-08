import { ToolMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";
import { compactObservation } from "../context.js";

export function toolObservation(result) {
    if (typeof result === "string") return JSON.parse(result);
    if (result && typeof result === "object") return result;
    throw new Error("Invalid tool observation.");
}

export async function runTool(state, context) {
    const call = state.pendingTool;
    const selected = context.registry.byName.get(call.name);
    let observation;

    try {
        observation = toolObservation(await selected.invoke(call.args));
    } catch (error) {
        // LangGraph must receive the interrupt so it can save and resume this node.
        if (isGraphInterrupt(error)) throw error;
        observation = {
            success: false,
            observation:
                "Tool failed. Check arguments and fresh observations; no automatic submission retry.",
        };
    }

    const update = {
        lastObservation: observation,
    };
    if (observation.snapshot) {
        update.latestSnapshot = observation.snapshot;
        update.observationWindow = observation.observationWindow ?? {};
    }
    update.actionHistory = [...(state.actionHistory ?? []), {
        tool: call.name,
        success: observation.success,
        ...(call.args.ref ? { ref: call.args.ref } : {}),
        ...(call.args.url ? { url: call.args.url } : {}),
        ...(observation.records ? { ids: observation.records.map((record) => record._id) } : {}),
        ...(observation.completed ? { completed: observation.completed } : {}),
        ...(observation.approvedAction ? { approvedAction: true } : {}),
        ...(!observation.success ? { error: String(observation.observation).slice(0, 300) } : {}),
    }];
    if (observation.approvedAction) update.hasAction = true;
    if (observation.humanAnswer)
        update.clarifications = [
            ...(state.clarifications ?? []),
            { question: observation.humanQuestion, answer: observation.humanAnswer },
        ].slice(-8);
    if (
        observation.success &&
        ["db_query", "browser_goto", "browser_snapshot", "browser_back"].includes(call.name)
    )
        update.evidenceCount = state.evidenceCount + 1;

    if (call.name === "remember" && observation.success) {
        const { key, value } = observation.memory;
        if (Object.keys(state.memory).length >= 20 && !Object.hasOwn(state.memory, key)) {
            observation = { success: false, observation: "Task memory limit reached." };
            update.lastObservation = observation;
        } else {
            update.memory = { ...state.memory, [key]: value };
        }
    }
    if (call.name === "finish" && observation.success) {
        if (state.hasAction) {
            const criteria = observation.criteria ?? [];
            const supported = state.verification?.success &&
                criteria.length === state.successCriteria.length &&
                criteria.every((entry, index) => entry.met &&
                    entry.criterion === state.successCriteria[index]);
            if (!supported)
                update.failure = "Verified action does not establish every requested success criterion.";
        }
        update.finishSummary = observation.finish;
    }

    update.errorCount = observation.success ? 0 : state.errorCount + 1;

    // Send compact records; preserve full observations in lastObservation and the persisted trace.
    const message = new ToolMessage({
        content: JSON.stringify(compactObservation(observation)),
        tool_call_id: call.id,
        name: call.name,
    });
    update.messages = [...state.messages, message].slice(-12);

    return update;
}
