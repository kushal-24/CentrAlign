import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { readConfig } from "../config.js";
import { User } from "../site/models/index.js";
import apiError from "../utils/apiError.js";
import { createLLM, createRateLimiter, isDailyQuotaError } from "./llm.js";
import { createInitialState } from "./state.js";
import { createAgentGraph } from "./graph.js";
import { createSessionManager, createTaskTools } from "./tools/index.js";
import * as runs from "./runs.js";

export function createRuntime(options = {}) {
    const config = options.config ?? readConfig(process.env, { requireStudent: true });
    const manager = options.manager ?? createSessionManager({ config });
    const store = options.store ?? runs;
    const active = new Map();
    // One limiter for all tasks keeps the whole agent under the provider's per-minute cap.
    const limiter =
        options.limiter ??
        (options.model
            ? undefined
            : createRateLimiter({ maxPerMinute: config.LLM_REQUESTS_PER_MINUTE ?? 4 }));
    const checkpointer = new MemorySaver();
    const graph = createAgentGraph({
        checkpointer,
        getContext: (taskId) => {
            const context = active.get(taskId)?.context;
            if (!context) throw new Error("Task context is unavailable.");
            return context;
        },
    });
    let closing = false;

    async function closeTask(taskId) {
        await manager.closeSession(taskId);
        await checkpointer.deleteThread(taskId);
        active.delete(taskId);
    }

    async function executeTask(taskId, state) {
        const entry = active.get(taskId);
        let sequence = 0;
        try {
            const account = options.resolveAccount
                ? await options.resolveAccount()
                : await User.findOne({ email: config.STUDENT_EMAIL.toLowerCase().trim() })
                      .select("_id email")
                      .lean();
            if (!account?._id) throw new Error("Configured account unavailable.");

            await manager.createSession(taskId);
            entry.context = {
                model: options.model ?? createLLM(),
                registry: options.createTools
                    ? options.createTools(manager, taskId, account)
                    : createTaskTools(manager, taskId, {
                          userId: String(account._id),
                          email: account.email,
                      }),
                maxSteps: config.MAX_STEPS,
                siteUrl: config.SITE_URL,
                modelOptions: { limiter, ...options.modelOptions, signal: entry.abort.signal },
                closeSession: manager.closeSession,
            };

            const stream = await graph.stream(state, {
                configurable: { thread_id: taskId },
                recursionLimit: config.MAX_STEPS * 4 + 20,
                streamMode: "updates",
            });
            for await (const chunk of stream) {
                if (chunk.__interrupt__?.length) {
                    entry.paused = true;
                    await store.recordProgress(taskId, {
                        status: "awaiting_approval",
                        pendingInterrupt: chunk.__interrupt__[0].value,
                    });
                    await store.appendTrace(taskId, {
                        sequence: ++sequence,
                        node: "tools",
                        summary: "Paused for human approval; no marked click executed.",
                        status: "awaiting_approval",
                        durationMs: 0,
                    });
                    continue;
                }

                for (const update of Object.values(chunk)) {
                    state = { ...state, ...update };
                    await store.recordProgress(taskId, state);
                    await store.appendTrace(taskId, {
                        ...update.trace,
                        sequence: ++sequence,
                        status: state.status,
                    });
                }
            }
        } catch (error) {
            // Raw provider/browser errors can contain credentials or response payloads.
            await store.recordProgress(taskId, {
                status: "failed",
                pendingInterrupt: null,
                result: {
                    success: false,
                    summary: isDailyQuotaError(error.cause)
                        ? "Gemini daily quota exhausted. Retry after quota reset or update local provider configuration."
                        : "Task failed. Check configuration/provider/site availability or start a new task after restart.",
                    node: error.executionNode ?? "runtime",
                    providerStatus: Number.isInteger(error.cause?.status)
                        ? error.cause.status
                        : null,
                },
            });
            await store.appendTrace(taskId, {
                sequence: ++sequence,
                node: "runtime",
                summary: "Task stopped after an execution or persistence error.",
                status: "failed",
                durationMs: 0,
            });
            entry.paused = false;
        } finally {
            if (!entry.paused) await closeTask(taskId);
        }
    }

    async function startTask(task) {
        if (closing) throw new apiError(503, "Agent is shutting down.");
        if (active.size >= 4)
            throw new apiError(
                429,
                "Four tasks are active or paused. Complete them before starting more.",
            );

        const taskId = randomUUID();
        const entry = {
            context: null,
            abort: new AbortController(),
            paused: false,
            job: null,
            preparing: null,
        };
        active.set(taskId, entry);
        try {
            entry.preparing = store.createRun(taskId, task);
            await entry.preparing;
        } catch {
            active.delete(taskId);
            throw new apiError(503, "Task storage unavailable.");
        }

        if (closing) {
            await store.recordProgress(taskId, {
                status: "failed",
                result: { success: false, summary: "Agent stopped before execution." },
            });
            await closeTask(taskId);
            throw new apiError(503, "Agent is shutting down.");
        }

        entry.job = executeTask(taskId, createInitialState(taskId, task));
        // Failures in error reporting must also be handled, never left as unhandled rejections.
        entry.job.catch(async () => {
            entry.paused = false;
            await closeTask(taskId).catch(() => {});
        });
        return { taskId, status: "running" };
    }

    async function closeRuntime() {
        closing = true;
        for (const entry of active.values()) entry.abort.abort();
        await Promise.allSettled(
            [...active.values()].map(async (entry) => {
                await entry.preparing;
                await entry.job;
            }),
        );
        for (const taskId of [...active.keys()]) {
            await store.recordProgress(taskId, {
                status: "failed",
                pendingInterrupt: null,
                result: { success: false, summary: "Agent stopped; start a new task." },
            });
            await closeTask(taskId);
        }
        await manager.closeAll();
    }

    return {
        startTask,
        executeTask,
        getActiveTask: (taskId) => active.get(taskId),
        closeTask,
        closeRuntime,
        readRun: store.readRun,
        readTrace: store.readTrace,
        recoverRuns: store.recoverRuns,
        get size() {
            return active.size;
        },
    };
}

let runtime;
export function getRuntime() {
    runtime ??= createRuntime();
    return runtime;
}
