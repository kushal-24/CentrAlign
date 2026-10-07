import { z } from "zod";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getPlanPrompt } from "../prompt.js";
import { invokeModel } from "../llm.js";

export const planSchema = z
    .object({ plan: z.array(z.string().min(1).max(500)).min(1).max(8) })
    .strict();

export async function plan(state, context) {
    const model = context.model.withStructuredOutput(planSchema);
    const response = await invokeModel(
        model,
        [new SystemMessage(getPlanPrompt(state)), new HumanMessage(state.task)],
        context.modelOptions,
    );

    return planSchema.parse(response);
}
