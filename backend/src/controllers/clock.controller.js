import mongoose from "mongoose";
import apiError from "../utils/apiError.js";
import apiResponse from "../utils/apiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { getNow, parseInstant } from "../site/lib/clock.js";
import { Config } from "../site/models/config.model.js";

export function localhostOnly(req, res, next) {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
        return next(new apiError(403, "Clock administration is restricted to localhost"));
    }
    next();
}

export const readClock = asyncHandler(async (req, res) => {
    if (mongoose.connection.readyState !== 1) throw new apiError(503, "Database is disconnected");
    res.json(new apiResponse({ now: (await getNow()).toISOString() }, 200, "Site clock"));
});

export const updateClock = asyncHandler(async (req, res) => {
    const now = parseInstant(req.body?.now);
    if (mongoose.connection.readyState !== 1) throw new apiError(503, "Database is disconnected");
    const updated = await Config.findOneAndUpdate(
        { key: "mockNow" },
        { $set: { value: now.toISOString() } },
        { new: true, runValidators: true },
    );
    if (!updated)
        throw new apiError(503, "Site clock is not initialized. Seed the demo database first.");
    res.json(new apiResponse({ now: updated.value }, 200, "Site clock updated"));
});
