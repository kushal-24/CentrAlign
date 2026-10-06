import mongoose from "mongoose";
import asyncHandler from "../../utils/asyncHandler.js";
import apiError from "../../utils/apiError.js";
import { getNow } from "../lib/clock.js";
import { User } from "../models/user.model.js";

const moneyFormat = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
});
const dateFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
});
export const formatTime = (instant) => `${dateFormat.format(instant)} IST`;
export const formatMoney = (amount) => moneyFormat.format(amount);
export const validId = (id) => typeof id === "string" && /^[a-f\d]{24}$/i.test(id);

export function pageDefaults(req, res, next) {
    res.locals.currentPath = req.path;
    res.locals.user = null;
    res.locals.now = null;
    res.locals.formatTime = formatTime;
    res.locals.formatMoney = formatMoney;
    res.set("Cache-Control", "no-store");
    next();
}

export const pageContext = asyncHandler(async (req, res, next) => {
    if (mongoose.connection.readyState !== 1)
        throw new apiError(503, "MatchDay is temporarily unavailable. Please try again shortly.");
    res.locals.now = await getNow();
    next();
});

export const requireUser = asyncHandler(async (req, res, next) => {
    const uid = req.cookies?.uid;
    if (!validId(uid))
        throw new apiError(401, "Open your demo session to view your tickets and messages.");
    const user = await User.findById(uid).lean();
    if (!user)
        throw new apiError(
            401,
            "Your demo session is unavailable. Please open a valid demo session.",
        );
    res.locals.user = user;
    next();
});
