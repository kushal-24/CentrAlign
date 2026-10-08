import { AIMessage } from "@langchain/core/messages";

// Testing only: inject scripted responses into the actual production graph.
export function createScriptedModel(calls, options = {}) {
    let index = 0;
    return {
        withStructuredOutput(schema) {
            return {
                invoke: async () =>
                    schema.shape.goal
                        ? {
                              goal: "Complete the requested MatchDay task",
                              successCriteria: options.successCriteria ?? ["Use observed facts"],
                              assumptions: [],
                              taskKind: options.taskKind ?? "read",
                          }
                        : schema.shape.criteria
                          ? {
                                criteria: (options.successCriteria ?? ["Use observed facts"]).map(
                                    (criterion) => ({ criterion, met: options.verifyMet ?? true }),
                                ),
                                summary: "Action independently verified from database records.",
                            }
                          : { plan: ["Inspect relevant facts", "Finish with the observed result"] },
            };
        },
        bindTools() {
            return {
                invoke: async (messages) => {
                    const call =
                        typeof calls === "function"
                            ? calls(index++, messages)
                            : index < calls.length
                              ? calls[index++]
                              : calls.at(-1);
                    const toolCalls = call === null ? [] : Array.isArray(call) ? call : [call];
                    return new AIMessage({
                        content: "",
                        tool_calls: toolCalls.map((entry, offset) => ({
                            ...entry,
                            id: entry.id ?? `call-${index}-${offset}`,
                            type: "tool_call",
                        })),
                    });
                },
            };
        },
    };
}
