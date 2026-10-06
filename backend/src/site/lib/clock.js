import apiError from "../../utils/apiError.js";
import { Config, isValidClockTime } from "../models/config.model.js";

export function parseInstant(value) {
    if (!isValidClockTime(value)) {
        throw new apiError(400, "Provide a valid ISO timestamp with an explicit timezone");
    }
    return new Date(value);
}

export async function getNow() {
    const record = await Config.findOne({ key: "mockNow" }).lean();
    if (!record)
        throw new apiError(503, "Site clock is not initialized. Seed the demo database first.");
    return parseInstant(record.value);
}

export function getMatchStatus(match, now) {
    if (now < match.startsAt) return "upcoming";
    if (now < match.endsAt) return "live";
    return "past";
}

export function getRefundAmount(match, booking, now) {
    if (
        booking.status !== "booked" ||
        now >= match.startsAt ||
        match.refundFullHoursBefore === null
    )
        return 0;
    const cutoff = match.startsAt.getTime() - match.refundFullHoursBefore * 60 * 60 * 1000;
    return now.getTime() <= cutoff ? booking.totalPrice : 0;
}
