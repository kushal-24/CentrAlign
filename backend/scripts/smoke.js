import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { chromium } from "playwright";
import { tool } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import {
    Annotation,
    Command,
    END,
    MemorySaver,
    START,
    StateGraph,
    interrupt,
} from "@langchain/langgraph";
import { z } from "zod";
import { ConfigurationError, readConfig } from "../src/config.js";
import connectDB from "../src/db/index.js";
import { createLLM } from "../src/agent/llm.js";
import { app as siteApp } from "../src/site/server.js";

export async function mongoSmoke() {
    readConfig();
    try {
        await connectDB();
        const response = await mongoose.connection.db.command({ ping: 1 });
        assert.equal(response.ok, 1);
    } finally {
        await mongoose.disconnect();
    }
}

export async function graphSmoke() {
    const State = Annotation.Root({ answer: Annotation() });
    const graph = new StateGraph(State)
        .addNode("question", () => ({
            answer: interrupt({ type: "question", question: "Phase 1 smoke?" }),
        }))
        .addEdge(START, "question")
        .addEdge("question", END)
        .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: `phase1-${randomUUID()}` } };
    const paused = await graph.invoke({ answer: null }, config);
    assert.equal(paused.__interrupt__.length, 1);
    assert.equal(paused.__interrupt__[0].value.type, "question");
    const resumed = await graph.invoke(new Command({ resume: "confirmed" }), config);
    assert.equal(resumed.answer, "confirmed");
    assert.ok(!resumed.__interrupt__?.length);
    const checkpoint = await graph.getState(config);
    assert.equal(checkpoint.values.answer, "confirmed");
    assert.deepEqual(checkpoint.next, []);
}

export async function browserSmoke() {
    const server = await new Promise((resolve, reject) => {
        const listener = siteApp.listen(0, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    let browser;
    try {
        browser = await chromium.launch({ headless: readConfig().HEADLESS });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`, { timeout: 15000 });
        assert.equal(await page.title(), "MatchDay");
        assert.equal(await page.locator("h1").innerText(), "MatchDay");
        const directory = fileURLToPath(new URL("../evidence/phase1/", import.meta.url));
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: `${directory}/playwright.png` });
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
}

export async function geminiSmoke() {
    const hello = tool(({ name }) => `Hello, ${name}!`, {
        name: "phase1_hello",
        description: "Return a greeting for a supplied name. Harmless Phase 1 dummy tool.",
        schema: z.object({ name: z.string() }),
    });
    const model = createLLM().bindTools([hello], { tool_choice: "any" });
    const input = { role: "user", content: "Call phase1_hello exactly once with name MatchPilot." };
    const response = await model.invoke([input], { signal: AbortSignal.timeout(30000) });
    assert.equal(response.tool_calls?.length, 1);
    const call = response.tool_calls[0];
    assert.equal(call.name, "phase1_hello");
    assert.equal(call.args.name, "MatchPilot");
    assert.ok(call.id);
    const result = await hello.invoke(call.args);
    assert.equal(result, "Hello, MatchPilot!");
    const final = await createLLM().invoke(
        [input, response, new ToolMessage({ content: result, tool_call_id: call.id })],
        { signal: AbortSignal.timeout(30000) },
    );
    assert.ok(final.content.length > 0);
}

const checks = { mongo: mongoSmoke, graph: graphSmoke, browser: browserSmoke, gemini: geminiSmoke };
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const names = process.argv[2] ? [process.argv[2]] : Object.keys(checks);
    for (const name of names) {
        if (!checks[name]) {
            process.stderr.write(`Unknown smoke check: ${name}\n`);
            process.exitCode = 1;
            break;
        }
        try {
            await checks[name]();
            process.stdout.write(`PASS ${name}\n`);
        } catch (error) {
            const detail =
                error instanceof ConfigurationError
                    ? error.message
                    : "check runtime access; provider errors are withheld to protect credentials";
            process.stderr.write(`FAIL ${name}: ${detail}\n`);
            process.exitCode = 1;
        }
    }
}
