import apiError from "../../utils/apiError.js";
import { validId } from "../middleware/page-context.js";
import { getMatchStatus } from "../lib/clock.js";

export function textField(body, key, label, max = 160) {
    const value = body?.[key];

    if (typeof value !== "string" || !value.trim() || value.length > max) {
        throw new apiError(400, `Enter a valid ${label}.`);
    }

    return value.trim();
}

export function quantityField(body) {
    const value = textField(body, "quantity", "ticket quantity", 10);
    const quantity = Number(value);

    if (!/^\d+$/.test(value) || !Number.isSafeInteger(quantity) || quantity < 1) {
        throw new apiError(400, "Enter a positive whole number of tickets.");
    }

    return quantity;
}

export function requireConfirmation(body) {
    if (body?.confirm !== "yes") {
        throw new apiError(400, "Please confirm the details before submitting.");
    }
}

export function requireMatchId(id) {
    if (!validId(id)) throw new apiError(404, "This match could not be found.");
}

export function requireBookable(match, now, quantity) {
    if (!match) throw new apiError(404, "This match could not be found.");

    if (getMatchStatus(match, now) !== "upcoming") {
        throw new apiError(409, "Bookings are closed for this match.");
    }

    if (match.bookingStatus !== "open") {
        throw new apiError(409, "This match has been postponed. Bookings are on hold.");
    }

    if (quantity > match.perBookingLimit) {
        throw new apiError(
            400,
            `Maximum ${match.perBookingLimit} tickets per booking for this match.`,
        );
    }
}

export function contactFields(body) {
    const ownerName = textField(body, "ownerName", "attendee name");
    const ownerEmail = textField(body, "ownerEmail", "email address").toLowerCase();
    const phone = textField(body, "phone", "phone number", 16);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
        throw new apiError(400, "Enter a valid email address.");
    }

    if (!/^\+?[1-9]\d{6,14}$/.test(phone)) {
        throw new apiError(400, "Enter a valid phone number, including the country code.");
    }

    return { ownerName, ownerEmail };
}

export function formValues(body, keys) {
    return Object.fromEntries(
        keys.map((key) => [key, typeof body?.[key] === "string" ? body[key].slice(0, 160) : ""]),
    );
}
