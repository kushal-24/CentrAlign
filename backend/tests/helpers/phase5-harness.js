import { Annotation, StateGraph, MemorySaver, Command } from "@langchain/langgraph";

// Testing-only graph. The production Gemini graph arrives in Phase 6.
export function createApprovalHarness(browserTools, taskId) {
    const State = Annotation.Root({ ref: Annotation(), result: Annotation() });

    async function clickControl(state) {
        const result = await browserTools.runTool("browser_click", { ref: state.ref });
        return { result };
    }

    const graph = new StateGraph(State)
        .addNode("clickControl", clickControl)
        .addEdge("__start__", "clickControl")
        .addEdge("clickControl", "__end__")
        .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: taskId } };
    let running = false;
    let proposal;

    async function invoke(input) {
        if (running) throw new Error("Graph is already running.");
        running = true;
        try {
            const result = await graph.invoke(input, config);
            proposal = result.__interrupt__?.[0]?.value;
            return result;
        } finally {
            running = false;
        }
    }

    function start(ref) {
        if (proposal) throw new Error("Graph is awaiting approval.");
        return invoke({ ref });
    }

    function resume(answer) {
        if (!proposal || answer?.proposalId !== proposal.proposalId)
            throw new Error("No matching pending approval.");
        return invoke(new Command({ resume: answer }));
    }

    return {
        start,
        resume,
        get proposal() {
            return proposal;
        },
    };
}
