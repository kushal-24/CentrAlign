import express from "express";
import mongoose from "mongoose";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import connectDB from "../db/index.js";
import { runServer } from "../server.js";
import apiResponse from "../utils/apiResponse.js";
import { getRuntime } from "./runtime.js";
import { createTaskRouter } from "./routes/tasks.routes.js";

export function createAgentApp(runtime = getRuntime) {
    const app = express();
    app.use(express.json({ limit: "16kb" }));

    app.get("/health", (req, res) => {
        const connected = mongoose.connection.readyState === 1;
        const status = connected ? 200 : 503;
        res.status(status).json(
            new apiResponse(
                {
                    service: "MatchPilot",
                    phase: 7,
                    database: connected ? "connected" : "disconnected",
                },
                status,
            ),
        );
    });
    app.use("/tasks", createTaskRouter(runtime));
    app.use((req, res) => res.status(404).json(new apiResponse(null, 404, "Route not found.")));
    app.use((error, req, res, next) => {
        const status =
            error.statusCode ??
            (error.type === "entity.too.large"
                ? 413
                : error.type === "entity.parse.failed"
                  ? 400
                  : 503);
        const message = error.statusCode
            ? error.message
            : status === 400
              ? "Invalid JSON body."
              : status === 413
                ? "Request body too large."
                : "Agent service unavailable.";
        res.status(status).json(new apiResponse(null, status, message));
    });

    return app;
}

export const app = createAgentApp();

export async function startAgent() {
    await connectDB();
    const runtime = getRuntime();
    await runtime.recoverRuns();

    const port = readConfig().AGENT_PORT;
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(port, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    process.stdout.write(`MatchPilot ready at http://127.0.0.1:${port}\n`);

    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, async () => {
            await runtime.closeRuntime().catch(() => {
                process.exitCode = 1;
            });
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            await mongoose.disconnect();
        });
    }
    return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runServer(startAgent);
}
