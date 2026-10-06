import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { readConfig } from "../config.js";

export function createLLM() {
    const config = readConfig(process.env, { requireGemini: true });
    return new ChatGoogleGenerativeAI({
        apiKey: config.GEMINI_API_KEY,
        model: config.GEMINI_MODEL,
        temperature: 0,
        maxRetries: 0,
    });
}
