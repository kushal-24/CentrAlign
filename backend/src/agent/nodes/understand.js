import { z } from "zod";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getUnderstandPrompt } from "../prompt.js";
import { invokeModel } from "../llm.js";

export const understandingSchema = z
    .object({
        goal: z.string().trim().min(1).max(1500),
        successCriteria: z.array(z.string().min(1).max(500)).min(1).max(8),
        assumptions: z.array(z.string().max(500)).max(8),
        taskKind: z.enum(["read", "action"]),
    })
    .strict();

export async function understand(state, context) {
    const model = context.model.withStructuredOutput(understandingSchema);
    const response = await invokeModel(
        model,
        [new SystemMessage(getUnderstandPrompt()), new HumanMessage(state.task)],
        context.modelOptions,
    );

    const parsed = understandingSchema.parse(response);

    return { ...parsed, taskKind: parsed.taskKind ?? "action" };
}
