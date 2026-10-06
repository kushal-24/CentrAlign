import express from "express";
import mongoose from "mongoose";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import { runServer, startServer } from "../server.js";
import apiResponse from "../utils/apiResponse.js";

export const app = express();
app.use(express.json({ limit: "16kb" }));
app.get("/health", (req, res) => {
    const connected = mongoose.connection.readyState === 1;
    const status = connected ? 200 : 503;
    res.status(status).json(
        new apiResponse(
            { service: "MatchPilot", phase: 1, database: connected ? "connected" : "disconnected" },
            status,
        ),
    );
});

export function startAgent() {
    return startServer(app, readConfig().AGENT_PORT, "MatchPilot");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runServer(startAgent);
}
