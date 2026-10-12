import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { getAgentPrompt } from "../prompt.js";
import { compactHistory, selectAgentTools } from "../context.js";
import { invokeModel, bindAgentTools, isMalformedToolCall, salvageFinishText, estimateRequestTokens } from "../llm.js";

export function buildAgentMessages(state, context, maxPairs = 2, tight = false) {
    // Keep complete AI/tool pairs so bounded history never leaves orphan ToolMessages.
    return [
        new SystemMessage(getAgentPrompt(state, tight ? { ...context, tight } : context)),
        new HumanMessage(state.task),
        ...compactHistory(state.messages, maxPairs),
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
    const modelOptions = {
        ...context.modelOptions,
        requestSchema: tools.map((entry) => ({ type: "function", function: {
            name: entry.name, description: entry.description,
            parameters: z.toJSONSchema(entry.schema),
        } })),
        ...(state.recoveryActive ? { attempts: 1 } : {}),
    };
    let messages = buildAgentMessages(state, context);
    const tokenBudget = modelOptions.limiter?.maxTokensPerMinute ?? Infinity;
    // Drop complete optional pairs only. Current state, approvals and evidence stay in the prompt.
    // Last resort: a smaller page view; the prompt tells the model to use browser_snapshot for omitted parts.
    for (const [maxPairs, tight] of [[1, false], [0, false], [0, true]]) {
        if (estimateRequestTokens(messages, modelOptions) <= tokenBudget) break;
        messages = buildAgentMessages(state, context, maxPairs, tight);
    }
    let response;
    try {
        response = await invokeModel(
            model,
            messages,
            modelOptions,
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
