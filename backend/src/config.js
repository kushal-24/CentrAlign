import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

const port = z.coerce.number().int().min(1).max(65535);
const schema = z.object({
    MONGODB_URI: z
        .string()
        .trim()
        .regex(/^mongodb(?:\+srv)?:\/\/\S+$/),
    GEMINI_API_KEY: z.string().trim().min(1).optional(),
    GEMINI_MODEL: z.string().trim().min(1).default("gemini-2.5-flash"),
    LLM_PROVIDER: z.enum(["gemini", "groq"]).default("gemini"),
    GROQ_API_KEY: z.string().trim().min(1).optional(),
    GROQ_MODEL: z.string().trim().min(1).default("openai/gpt-oss-20b"),
    SITE_URL: z
        .string()
        .url()
        .default("http://localhost:4000")
        .refine((value) => {
            const url = new URL(value);
            return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
        }),
    SITE_PORT: port.default(4000),
    AGENT_PORT: port.default(5000),
    STUDENT_EMAIL: z.string().email().optional(),
    LLM_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(4),
    MAX_STEPS: z.coerce.number().int().positive().default(25),
    HEADLESS: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),
});

export class ConfigurationError extends Error {}

export function readConfig(
    env = process.env,
    { requireGemini = false, requireLLM = false, requireStudent = false } = {},
) {
    const input = { ...env };
    for (const key of ["GEMINI_API_KEY", "GROQ_API_KEY", "STUDENT_EMAIL"]) {
        if (input[key] === "") delete input[key];
    }
    // Explicit selection wins; otherwise prefer the user's configured Groq key.
    if (!input.LLM_PROVIDER && input.GROQ_API_KEY?.trim()) input.LLM_PROVIDER = "groq";
    const result = schema.safeParse(input);
    if (!result.success) {
        const keys = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
        throw new ConfigurationError(`Invalid or missing configuration: ${keys.join(", ")}`);
    }
    const missing = [];
    if (requireGemini && !result.data.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
    if (requireLLM) {
        const key = result.data.LLM_PROVIDER === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY";
        if (!result.data[key]) missing.push(key);
    }
    if (requireStudent && !result.data.STUDENT_EMAIL) missing.push("STUDENT_EMAIL");
    if (missing.length)
        throw new ConfigurationError(`Missing configuration: ${missing.join(", ")}`);
    if (result.data.SITE_PORT === result.data.AGENT_PORT) {
        throw new ConfigurationError("SITE_PORT and AGENT_PORT must be different");
    }
    return Object.freeze(result.data);
}
