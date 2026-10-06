import express from "express";
import mongoose from "mongoose";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readConfig } from "../config.js";
import { runServer, startServer } from "../server.js";
import apiResponse from "../utils/apiResponse.js";

export const app = express();
app.set("view engine", "ejs");
app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));
app.get("/", (req, res) => res.render("index"));
app.get("/health", (req, res) => {
    const connected = mongoose.connection.readyState === 1;
    const status = connected ? 200 : 503;
    res.status(status).json(new apiResponse({ service: "MatchDay", phase: 1, database: connected ? "connected" : "disconnected" }, status));
});

export function startSite() {
    return startServer(app, readConfig().SITE_PORT, "MatchDay");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runServer(startSite);
}
