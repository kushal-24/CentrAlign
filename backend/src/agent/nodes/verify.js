import { z } from "zod";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { invokeModel } from "../llm.js";
import { getVerificationPrompt } from "../prompt.js";

const verificationSchema = z
    .object({
        criteria: z
            .array(z.object({ criterion: z.string().min(1).max(500), met: z.boolean() }).strict())
            .min(1)
            .max(8),
        summary: z.string().trim().min(1).max(2000),
    })
    .strict();

export async function verify(state, context) {
    if (!context.registry.verifyActions)
        return {
            failure:
                "Action completion requires independent Phase 8 verification; no verifier is available.",
        };

    const evidence = await context.registry.verifyActions();
    if (!evidence.success)
        return {
            verification: evidence,
            failure:
                "Independent action verification failed. Inspect the evidence; no automatic submission retry.",
        };

    // Only read-only evidence goes into this separate call. No action tools are bound.
    const model = context.model.withStructuredOutput(verificationSchema);
    const response = verificationSchema.parse(
        await invokeModel(
            model,
            [
                new SystemMessage(getVerificationPrompt(state, evidence)),
                new HumanMessage(state.task),
            ],
            context.modelOptions,
        ),
    );
    const supported =
        response.criteria.length === state.successCriteria.length &&
        response.criteria.every(
            (entry, index) => entry.met && entry.criterion === state.successCriteria[index],
        );

    return {
        verification: { ...evidence, criteria: response.criteria },
        failure: supported
            ? null
            : "The verified action does not meet every requested success criterion.",
        finishSummary: supported ? response.summary : state.finishSummary,
    };
}
