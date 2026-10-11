import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import { readConfig } from "../config.js";

let groqRequestIndex = 0;

// Select at invocation time, including structured calls, tool calls and retries.
// The shared counter alternates requests across tasks in this server process.
function alternateGroqModels(models) {
    return {
        _llmType: () => "groq",
        invoke(input, options) {
            const selected = models[groqRequestIndex % models.length];
            groqRequestIndex = (groqRequestIndex + 1) % models.length;
            return selected.invoke(input, options);
        },
        bindTools(...args) {
            return alternateGroqModels(models.map((model) => model.bindTools(...args)));
        },
        withStructuredOutput(...args) {
            return alternateGroqModels(models.map((model) => model.withStructuredOutput(...args)));
        },
    };
}

export function createLLM() {
    const config = readConfig(process.env, { requireLLM: true });
    if (config.LLM_PROVIDER === "groq") {
        const keys = [...new Set([config.GROQ_API_KEY, config.GROQ_API_KEY_2].filter(Boolean))];
        const models = keys.map((apiKey) => new ChatGroq({
            apiKey,
            model: config.GROQ_MODEL,
            maxTokens: config.GROQ_MAX_OUTPUT_TOKENS,
            temperature: 0,
            maxRetries: 0,
        }));
        return models.length === 1 ? models[0] : alternateGroqModels(models);
    }

    return new ChatGoogleGenerativeAI({
        apiKey: config.GEMINI_API_KEY,
        model: config.GEMINI_MODEL,
        temperature: 0,
        maxRetries: 0,
    });
}

export function isDailyQuotaError(error) {
    const details = Array.isArray(error?.errorDetails) ? error.errorDetails : [];
    return details.some(
        (detail) =>
            Array.isArray(detail.violations) &&
            detail.violations.some((violation) => /PerDay/i.test(violation.quotaId ?? "")),
    );
}

export function isMalformedToolCall(error) {
    const code = error?.error?.error?.code ?? error?.error?.code ?? error?.code;
    return Number(error?.status) === 400 && code === "tool_use_failed";
}

export function isTransientModelError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    return !isDailyQuotaError(error) && (status === 429 || [500, 502, 503, 504].includes(status));
}

// When a required tool call is answered in prose, the provider returns that text in the error.
export function salvageFinishText(error) {
    const text = error?.error?.error?.failed_generation;
    if (typeof text !== "string") return null;

    const wrapped = text
        .trim()
        .match(/^\{\s*"name"\s*:\s*"([^"]*)"\s*,\s*"arguments"\s*:\s*([\s\S]*?)\}?$/);
    if (wrapped && !["finish", "summary"].includes(wrapped[1])) return null;

    const summary = (wrapped ? wrapped[2] : text).trim().replace(/^"|"$/g, "").trim();
    return summary.length >= 20 ? summary.slice(0, 4000) : null;
}

// Provider-requested wait (Retry-After seconds), capped so one call cannot stall a task for long.
export function retryAfterMs(error) {
    const headers = error?.headers;
    const value =
        typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 20000) : 0;
}

// Sliding-window limiter: at most `maxPerMinute` model requests in any 60 seconds.
export function createRateLimiter({
    maxPerMinute = 4,
    now = () => Date.now(),
    sleep = (milliseconds, signal) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, milliseconds);
            signal?.addEventListener(
                "abort",
                () => {
                    clearTimeout(timer);
                    reject(new Error("Rate limit wait aborted."));
                },
                { once: true },
            );
        }),
} = {}) {
    const stamps = [];

    return {
        async acquire(signal) {
            for (;;) {
                const current = now();
                while (stamps.length && current - stamps[0] >= 60000) stamps.shift();
                if (stamps.length < maxPerMinute) {
                    stamps.push(current);
                    return;
                }
                await sleep(60000 - (current - stamps[0]) + 50, signal);
            }
        },
    };
}

// Opt-in token accounting: set LLM_USAGE_LOG=<file> to append one JSON line per provider request
// (and per failed request, with rate-limit headers) and echo it to stderr. Never logs prompts.
function usageLogger(attempt) {
    const file = process.env.LLM_USAGE_LOG;
    if (!file) return undefined;
    const write = (entry) => {
        const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, attempt, ...entry });
        process.stderr.write(`[llm-usage] ${line}\n`);
        try {
            appendFileSync(file, `${line}\n`);
        } catch {
            // Logging must never break a run.
        }
    };
    return [
        {
            handleLLMEnd(output) {
                const message = output.generations?.[0]?.[0]?.message;
                const meta = message?.usage_metadata;
                const legacy = output.llmOutput?.tokenUsage;
                write({
                    ok: true,
                    inputTokens: meta?.input_tokens ?? legacy?.promptTokens ?? null,
                    outputTokens: meta?.output_tokens ?? legacy?.completionTokens ?? null,
                    totalTokens: meta?.total_tokens ?? legacy?.totalTokens ?? null,
                });
            },
            handleLLMError(error) {
                const headers = error?.headers;
                const read = (name) =>
                    typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
                write({
                    ok: false,
                    status: error?.status ?? null,
                    retryAfter: read("retry-after") ?? null,
                    limitTokens: read("x-ratelimit-limit-tokens") ?? null,
                    remainingTokens: read("x-ratelimit-remaining-tokens") ?? null,
                    resetTokens: read("x-ratelimit-reset-tokens") ?? null,
                    remainingRequests: read("x-ratelimit-remaining-requests") ?? null,
                    message: String(error?.error?.error?.message ?? error?.message ?? "").slice(0, 300),
                });
            },
        },
    ];
}

export async function invokeModel(model, input, options = {}) {
    const attempts = Math.min(options.attempts ?? 4, 4);
    const delay =
        options.delay ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            if (options.budget?.count >= options.budget?.limit) {
                const error = new Error("Agent reasoning budget exceeded.");
                error.code = "LLM_BUDGET_EXCEEDED";
                throw error;
            }
            // Every attempt is a provider request, so each one waits for the limiter.
            await options.limiter?.acquire(options.signal);
            if (options.budget) {
                if (options.budget.count >= options.budget.limit) {
                    const error = new Error("Agent reasoning budget exceeded. No further model requests were made.");
                    error.code = "LLM_BUDGET_EXCEEDED";
                    throw error;
                }
                options.budget.count += 1;
            }
            const timeout = AbortSignal.timeout(options.timeout ?? 30000);
            const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
            return await model.invoke(input, { signal, callbacks: usageLogger(attempt) });
        } catch (error) {
            if (
                options.signal?.aborted ||
                !isTransientModelError(error) ||
                attempt === attempts - 1
            )
                throw new Error(
                    "Model request failed or timed out. Check provider availability and configuration.",
                    { cause: error },
                );

            await delay(Math.max(Math.min(1000 * 2 ** attempt, 4000), retryAfterMs(error)));
        }
    }
    throw new Error("Model request failed.");
}

export function geminiToolSchema(schema) {
    if (Array.isArray(schema)) return schema.map(geminiToolSchema);
    if (!schema || typeof schema !== "object") return schema;

    const result = {};
    for (const [key, value] of Object.entries(schema)) {
        if (
            ["$schema", "additionalProperties", "exclusiveMinimum", "exclusiveMaximum"].includes(
                key,
            )
        )
            continue;
        result[key] = geminiToolSchema(value);
    }
    // Gemini rejects these JSON Schema keywords. Integer bounds can be expressed inclusively.
    if (schema.exclusiveMinimum !== undefined && schema.type === "integer")
        result.minimum = Math.floor(schema.exclusiveMinimum) + 1;
    if (schema.exclusiveMaximum !== undefined && schema.type === "integer")
        result.maximum = Math.ceil(schema.exclusiveMaximum) - 1;
    return result;
}

export function bindAgentTools(model, tools) {
    // Groq consumes the original tool schemas; Gemini needs its schema adapter.
    if (model instanceof ChatGroq || model._llmType?.() === "groq")
        return model.bindTools(tools, { tool_choice: "required", parallel_tool_calls: false });

    const declarations = tools.map((entry) => ({
        type: "function",
        function: {
            name: entry.name,
            description: entry.description,
            parameters: geminiToolSchema(z.toJSONSchema(entry.schema)),
        },
    }));

    // Only the advertised schemas change; execution still uses the original strict Zod tools.
    return model.bindTools(declarations, { tool_choice: "any" });
}
