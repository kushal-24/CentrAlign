import express from "express";
import mongoose from "mongoose";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readConfig } from "../config.js";
import { runServer, startServer } from "../server.js";
import apiResponse from "../utils/apiResponse.js";
import apiError from "../utils/apiError.js";
import clockRouter from "./routes/clock/clock.routes.js";

export const app = express();
app.set("view engine", "ejs");
app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));
app.use("/admin/clock", clockRouter);
app.get("/", (req, res) => res.render("index"));
app.get("/health", (req, res) => {
    const connected = mongoose.connection.readyState === 1;
    const status = connected ? 200 : 503;
    res.status(status).json(
        new apiResponse(
            { service: "MatchDay", phase: 1, database: connected ? "connected" : "disconnected" },
            status,
        ),
    );
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status =
        error instanceof apiError
            ? error.statusCode
            : error.type === "entity.parse.failed"
              ? 400
              : 500;
    const message =
        error instanceof apiError
            ? error.message
            : status === 400
              ? "Invalid JSON body"
              : "Internal server error";
    res.status(status).json({ statusCode: status, success: false, message, errors: [] });
});

export function startSite() {
    return startServer(app, readConfig().SITE_PORT, "MatchDay");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runServer(startSite);
}
