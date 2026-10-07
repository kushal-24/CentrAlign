import { ToolMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";

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
    if (observation.snapshot) update.latestSnapshot = observation.snapshot;
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
    if (call.name === "finish" && observation.success) update.finishSummary = observation.finish;

    update.errorCount = observation.success ? 0 : state.errorCount + 1;

    // The latest snapshot already reaches the model through the agent prompt; do not repeat it per tool message.
    const { snapshot, ...modelObservation } = observation;
    const text = JSON.stringify(
        snapshot ? { ...modelObservation, snapshot: "see Latest page" } : observation,
    );
    const bounded =
        text.length <= 26000
            ? text
            : JSON.stringify({
                  success: observation.success,
                  observation:
                      "Large observation omitted; consult the latest snapshot or narrow the query.",
              });
    const message = new ToolMessage({ content: bounded, tool_call_id: call.id, name: call.name });
    update.messages = [...state.messages, message].slice(-12);

    return update;
}
