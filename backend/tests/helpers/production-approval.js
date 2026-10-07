import { Command } from "@langchain/langgraph";
import { createAgentGraph } from "../../src/agent/graph.js";
import { createInitialState } from "../../src/agent/state.js";
import { createControlTools } from "../../src/agent/tools/control.js";
import { createScriptedModel } from "./phase6-model.js";

// Testing caller only. All nodes, routing and checkpoints come from the production graph.
export function createApprovalDriver(browserTools, taskId) {
    let graph;
    let running = false;
    let proposal;
    let lastBrowserResult;
    const config = { configurable: { thread_id: taskId }, recursionLimit: 100 };

    async function invoke(input) {
        if (running) throw new Error("Graph is already running.");
        running = true;
        try {
            const state = await graph.invoke(input, config);
            proposal = state.__interrupt__?.[0]?.value;
            return { ...state, result: lastBrowserResult };
        } finally {
            running = false;
        }
    }

    function start(ref) {
        if (proposal) throw new Error("Graph is awaiting approval.");
        if (running) throw new Error("Graph is already running.");
        lastBrowserResult = null;
        const tools = [...browserTools.tools, ...createControlTools()];
        const byName = new Map(tools.map((entry) => [entry.name, entry]));
        const click = byName.get("browser_click");
        byName.set("browser_click", {
            invoke: async (args) => {
                const text = await click.invoke(args);
                lastBrowserResult = JSON.parse(text);
                return text;
            },
        });
        const model = createScriptedModel(
            [
                { name: "browser_click", args: { ref } },
                { name: "finish", args: { summary: "Browser observation collected." } },
            ],
            { taskKind: "action" },
        );
        graph = createAgentGraph({
            getContext: () => ({
                model,
                registry: { tools, byName },
                maxSteps: 10,
                siteUrl: "MatchDay test fixture",
            }),
        });

        return invoke(
            createInitialState(
                taskId,
                "Exercise a browser submission through the production graph",
            ),
        );
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
