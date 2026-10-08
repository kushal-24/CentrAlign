import { StateGraph, MemorySaver, START, END, isGraphInterrupt } from "@langchain/langgraph";
import { AgentState } from "./state.js";
import { understand } from "./nodes/understand.js";
import { plan } from "./nodes/plan.js";
import { callAgent } from "./nodes/agent.js";
import { runTool } from "./nodes/tools.js";
import { guard } from "./nodes/guard.js";
import { complete } from "./nodes/complete.js";
import { verify } from "./nodes/verify.js";

export function routeAfterAgent(state) {
    if (state.failure) return "guard";
    if (state.pendingTool) return "tools";
    return state.nudgeCount === 1 ? "agent" : "guard";
}

export function routeAfterGuard(state) {
    if (state.failure) return "complete";
    if (state.hasAction && !state.verification) return "verify";
    if (state.finishSummary)
        return state.verification?.success || state.taskKind === "read" && !state.hasAction
            ? "complete" : "verify";
    return "agent";
}

export function createAgentGraph(dependencies) {
    function node(name, handler) {
        return async (state) => {
            const context = dependencies.getContext(state.taskId);
            const started = performance.now();
            let update;
            try {
                update = await handler(state, context);
            } catch (error) {
                if (isGraphInterrupt(error)) throw error;
                error.executionNode = name;
                throw error;
            }
            const call = name === "tools" ? state.pendingTool : null;

            return {
                ...update,
                llmCallCount: context.modelOptions?.budget?.count ?? state.llmCallCount,
                ...(name === "agent" && state.recoveryActive && state.llmRecoveryCalls < 1
                    ? { llmRecoveryCalls: state.llmRecoveryCalls + 1 } : {}),
                trace: {
                    node: name,
                    durationMs: Math.round(performance.now() - started),
                    summary: name === "tools" ? `Executed ${call.name}.` : `${name} completed.`,
                    ...(call
                        ? { tool: call.name, args: call.args, observation: update.lastObservation }
                        : {}),
                    ...(update.warning ? { warning: update.warning } : {}),
                },
            };
        };
    }

    return new StateGraph(AgentState)
        .addNode("understand", node("understand", understand))
        .addNode("makePlan", node("makePlan", plan))
        .addNode("agent", node("agent", callAgent))
        .addNode("tools", node("tools", runTool))
        .addNode("guard", node("guard", guard))
        .addNode("verify", node("verify", verify))
        .addNode("complete", node("complete", complete))
        .addEdge(START, "understand")
        .addEdge("understand", "makePlan")
        .addEdge("makePlan", "agent")
        .addConditionalEdges("agent", routeAfterAgent, ["agent", "tools", "guard"])
        .addEdge("tools", "guard")
        .addConditionalEdges("guard", routeAfterGuard, ["agent", "verify", "complete"])
        .addConditionalEdges("verify", (state) => state.failure ? "complete" : "agent", ["complete", "agent"])
        .addEdge("complete", END)
        .compile({ checkpointer: dependencies.checkpointer ?? new MemorySaver() });
}
