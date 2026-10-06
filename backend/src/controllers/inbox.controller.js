import asyncHandler from "../utils/asyncHandler.js";
import { Outbox, Booking } from "../site/models/index.js";

export const listInbox = asyncHandler(async (req, res) => {
    const user = res.locals.user;

    const messages = await Outbox.find({ to: user.email.toLowerCase().trim() })
        .sort({ createdAt: -1, _id: -1 })
        .lean();

    const ids = messages
        .filter((message) => message.relatedBookingId)
        .map((message) => message.relatedBookingId);
    const bookings = ids.length
        ? await Booking.find({ userId: user._id, _id: { $in: ids } }).lean()
        : [];
    const ownedIds = new Set(bookings.map((booking) => booking._id.toString()));

    res.render("inbox/index", {
        title: "Inbox",
        messages: messages.map((message) => ({
            ...message,
            ticketLink:
                message.relatedBookingId && ownedIds.has(message.relatedBookingId.toString())
                    ? `/bookings/${message.relatedBookingId}`
                    : null,
        })),
    });
});
