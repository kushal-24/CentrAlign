import asyncHandler from "../utils/asyncHandler.js";
import apiError from "../utils/apiError.js";
import { Booking, Waitlist, Match } from "../site/models/index.js";
import { validId } from "../site/middleware/page-context.js";

import { presentMatch } from "./matches.controller.js";
import { getRefundAmount } from "../site/lib/clock.js";
import {
    requireMatchId,
    requireConfirmation,
    quantityField,
    contactFields,
    formValues,
} from "../site/services/action-validation.js";
import { bookTickets, cancelTicket } from "../site/services/booking.service.js";

export const listBookings = asyncHandler(async (req, res) => {
    const userId = res.locals.user._id;

    const [bookings, waitlist] = await Promise.all([
        Booking.find({ userId }).sort({ createdAt: -1, _id: -1 }).lean(),
        Waitlist.find({ userId }).sort({ createdAt: -1, _id: -1 }).lean(),
    ]);

    const ids = [...new Set([...bookings, ...waitlist].map((record) => record.matchId.toString()))];
    const matches = ids.length ? await Match.find({ _id: { $in: ids } }).lean() : [];
    const byId = new Map(matches.map((match) => [match._id.toString(), match]));
    const withMatch = (record) => ({ ...record, match: byId.get(record.matchId.toString()) });

    res.render("bookings/index", {
        title: "My bookings",
        bookings: bookings.map(withMatch),
        waitlist: waitlist.map(withMatch),
        joined: waitlist.find((entry) => entry._id.toString() === req.query.joined),
    });
});

export const showBooking = asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) throw new apiError(404, "This ticket could not be found.");

    const booking = await Booking.findOne({
        _id: req.params.id,
        userId: res.locals.user._id,
    }).lean();

    if (!booking) throw new apiError(404, "This ticket could not be found.");

    const match = await Match.findById(booking.matchId).lean();

    if (!match) throw new apiError(404, "The event for this ticket could not be found.");

    const page = ticketPage(booking, match, res.locals.now);

    if (req.query.created === "1" && booking.status === "booked")
        page.success = `Booking confirmed: ${booking.code}.`;
    if (req.query.cancelled === "1" && booking.status === "cancelled")
        page.success = `Booking cancelled: ${booking.code}.`;

    res.render("bookings/detail", page);
});

export const showBookingForm = asyncHandler(async (req, res) => {
    const match = await bookingMatch(req.params.id, res.locals.now);
    const user = res.locals.user;

    res.render("matches/book", {
        title: match.isFree ? "Reserve free entry" : "Book tickets",
        match,
        values: { quantity: "1", ownerName: user.name, ownerEmail: user.email, phone: user.phone },
        error: null,
    });
});

export const createBooking = asyncHandler(async (req, res) => {
    requireMatchId(req.params.id);

    try {
        const quantity = quantityField(req.body);
        const contact = contactFields(req.body);

        requireConfirmation(req.body);

        const booking = await bookTickets(req.params.id, res.locals.user, { quantity, ...contact });

        res.redirect(303, `/bookings/${booking._id}?created=1`);
    } catch (error) {
        if (!(error instanceof apiError) || ![400, 409].includes(error.statusCode)) throw error;

        const match = await bookingMatch(req.params.id, res.locals.now);

        res.status(error.statusCode).render("matches/book", {
            title: "Book tickets",
            match,
            values: formValues(req.body, [
                "quantity",
                "ownerName",
                "ownerEmail",
                "phone",
                "confirm",
            ]),
            error: error.message,
        });
    }
});

export const cancelBooking = asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) throw new apiError(404, "This ticket could not be found.");

    try {
        requireConfirmation(req.body);

        await cancelTicket(req.params.id, res.locals.user._id);

        res.redirect(303, `/bookings/${req.params.id}?cancelled=1`);
    } catch (error) {
        if (!(error instanceof apiError) || ![400, 409].includes(error.statusCode)) throw error;

        const booking = await Booking.findOne({
            _id: req.params.id,
            userId: res.locals.user._id,
        }).lean();

        if (!booking) throw new apiError(404, "This ticket could not be found.");

        const match = await Match.findById(booking.matchId).lean();

        if (!match) throw new apiError(404, "The event for this ticket could not be found.");

        res.status(error.statusCode).render(
            "bookings/detail",
            ticketPage(booking, match, res.locals.now, error.message),
        );
    }
});

async function bookingMatch(id, now) {
    requireMatchId(id);

    const match = await Match.findById(id).lean();

    if (!match) throw new apiError(404, "This match could not be found.");

    return presentMatch(match, now);
}

function ticketPage(booking, match, now, error = null) {
    return {
        title: `Ticket ${booking.code}`,
        booking,
        match,
        error,
        canCancel: booking.status === "booked" && now < match.startsAt,
        expectedRefund: getRefundAmount(match, booking, now),
        success: null,
    };
}
