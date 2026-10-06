import asyncHandler from "../utils/asyncHandler.js";
import apiError from "../utils/apiError.js";
import { Booking, Waitlist, Match } from "../site/models/index.js";
import { validId } from "../site/middleware/page-context.js";

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

    res.render("bookings/detail", { title: `Ticket ${booking.code}`, booking, match });
});
