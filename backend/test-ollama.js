
import { ChatOllama } from "@langchain/ollama";

const llm = new ChatOllama({
  model: "qwen2.5:3b",
  baseUrl: "http://127.0.0.1:11434",
  temperature: 0,
  numCtx: 4096,
  numPredict: 40,
});

console.log("Testing local Qwen3...");

try {
  const response = await llm.invoke(
    "Reply with exactly these words: CentrALign local LLM works"
  );

  console.log("Response:", response.content);
  console.log("Metadata:", response.response_metadata);
} catch (error) {
  console.error("Test failed:", error);
}
