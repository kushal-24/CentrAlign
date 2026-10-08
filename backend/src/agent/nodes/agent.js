import { randomUUID } from "node:crypto";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { getAgentPrompt } from "../prompt.js";
import { compactHistory, selectAgentTools } from "../context.js";
import { invokeModel, bindAgentTools, isMalformedToolCall, salvageFinishText } from "../llm.js";

export function buildAgentMessages(state, context) {
    // Keep complete AI/tool pairs so bounded history never leaves orphan ToolMessages.
    return [
        new SystemMessage(getAgentPrompt(state, context)),
        new HumanMessage(state.task),
        ...compactHistory(state.messages),
    ];
}

export async function callAgent(state, context) {
    if (state.recoveryActive && state.llmRecoveryCalls >= 1)
        return { pendingTool: null, failure: "Browser recovery budget exhausted after one LLM recovery attempt." };
    if (state.stepCount > context.maxSteps)
        return { pendingTool: null, failure: "Task step limit reached." };

    // Reserve one final turn for a summary, without allowing more actions.
    const finalTurn = state.stepCount === context.maxSteps;
    const tools = selectAgentTools(state, context.registry, finalTurn);
    const model = bindAgentTools(context.model, tools);
    let response;
    try {
        response = await invokeModel(
            model,
            buildAgentMessages(state, context),
            state.recoveryActive
                ? { ...context.modelOptions, attempts: 1 }
                : context.modelOptions,
        );
    } catch (error) {
        if (!isMalformedToolCall(error.cause)) throw error;

        // The model answered in prose where a tool call was required: submit that text as finish.
        const summary = salvageFinishText(error.cause);
        if (summary) {
            const call = {
                id: `finish-${randomUUID()}`,
                name: "finish",
                args: { summary },
                type: "tool_call",
            };
            return {
                stepCount: state.stepCount + 1,
                pendingTool: call,
                nudgeCount: 0,
                messages: [...state.messages, new AIMessage({ content: "", tool_calls: [call] })],
            };
        }

        // Otherwise the provider rejected an unparseable tool call; let the model try again.
        return {
            stepCount: state.stepCount + 1,
            pendingTool: null,
            nudgeCount: 0,
            errorCount: state.errorCount + 1,
            warning:
                "Your last tool call was malformed. Call exactly one tool with valid JSON arguments; keep finish summaries short plain text.",
            lastObservation: {
                success: false,
                observation: "Malformed tool call; nothing was executed.",
            },
        };
    }
    const calls = response.tool_calls ?? [];
    const stepCount = state.stepCount + 1;

    if (
        calls.length !== 1 ||
        typeof calls[0].id !== "string" ||
        !calls[0].id ||
        calls[0].id.length > 120 ||
        !tools.some((entry) => entry.name === calls[0].name)
    ) {
        const missing = calls.length === 0;
        return {
            stepCount,
            pendingTool: null,
            nudgeCount: missing ? state.nudgeCount + 1 : 0,
            errorCount: state.errorCount + (missing && state.nudgeCount === 0 ? 0 : 1),
            warning: missing
                ? "Call exactly one tool; use finish for a final answer."
                : "Invalid tool choice. Exactly one registered tool is required; nothing was executed.",
            lastObservation: {
                success: false,
                observation: "No valid single tool call was executed.",
            },
        };
    }

    const call = calls[0];
    if (finalTurn && call.name !== "finish")
        return { stepCount, pendingTool: null, failure: "Task step limit reached." };

    if (JSON.stringify(call.args).length > 6000)
        return { stepCount, pendingTool: null, failure: "Tool arguments exceeded the task limit." };

    // Plain model prose is unnecessary here; only preserve the validated tool call.
    response.content = "";
    return { stepCount, pendingTool: call, nudgeCount: 0, messages: [...state.messages, response] };
}
