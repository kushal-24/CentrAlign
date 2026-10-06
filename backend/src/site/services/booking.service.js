import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import apiError from "../../utils/apiError.js";
import { Match, Booking, Outbox, User } from "../models/index.js";
import { getNow, getRefundAmount } from "../lib/clock.js";
import { requireBookable } from "./action-validation.js";

export async function bookTickets(matchId, user, input) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await mongoose.connection.transaction(async (session) => {
                const now = await getNow();
                const match = await Match.findById(matchId).session(session).lean();

                requireBookable(match, now, input.quantity);

                const existing = await Booking.findOne({
                    userId: user._id,
                    matchId,
                    status: "booked",
                })
                    .session(session)
                    .lean();

                if (existing)
                    throw new apiError(
                        409,
                        `You already have a booking for this match (${existing.code}).`,
                    );

                const remaining = match.capacity - match.sold;

                if (remaining < input.quantity) {
                    throw new apiError(
                        409,
                        remaining === 0
                            ? "Tickets are sold out."
                            : `Only ${remaining} tickets left for this match.`,
                    );
                }

                const inventory = await Match.updateOne(
                    {
                        _id: matchId,
                        sold: match.sold,
                        bookingStatus: "open",
                        startsAt: { $gt: now },
                    },
                    { $inc: { sold: input.quantity } },
                    { session },
                );

                if (inventory.modifiedCount !== 1)
                    throw new apiError(409, "Ticket availability changed. Please try again.");

                const [booking] = await Booking.create(
                    [
                        {
                            code: `MD-${randomBytes(5).toString("hex").toUpperCase()}`,
                            matchId,
                            userId: user._id,
                            ownerName: input.ownerName,
                            ownerEmail: input.ownerEmail,
                            quantity: input.quantity,
                            totalPrice: match.price * input.quantity,
                            status: "booked",
                            refundAmount: 0,
                            createdAt: now,
                            cancelledAt: null,
                        },
                    ],
                    { session },
                );

                await Outbox.create(
                    [
                        {
                            to: user.email,
                            subject: `Booking confirmed: ${booking.code}`,
                            body: `${booking.code}: ${booking.quantity} ticket(s) for ${match.title}. Attendee: ${booking.ownerName} (${booking.ownerEmail}). Total INR ${booking.totalPrice}.`,
                            type: "booking_confirmation",
                            relatedBookingId: booking._id,
                            createdAt: now,
                        },
                    ],
                    { session },
                );

                return booking;
            });
        } catch (error) {
            if (error.code !== 11000) throw error;

            if (error.keyPattern?.code && attempt < 2) continue;

            throw new apiError(
                409,
                "You already have an active booking, or a booking reference could not be allocated. Check My Bookings before trying again.",
            );
        }
    }
}

export async function cancelTicket(bookingId, userId) {
    return mongoose.connection.transaction(async (session) => {
        const now = await getNow();
        const booking = await Booking.findOne({ _id: bookingId, userId }).session(session).lean();

        if (!booking) throw new apiError(404, "This ticket could not be found.");
        if (booking.status !== "booked")
            throw new apiError(409, "This booking is already cancelled.");

        const match = await Match.findById(booking.matchId).session(session).lean();

        if (!match) throw new apiError(404, "The event for this ticket could not be found.");
        if (now < booking.createdAt)
            throw new apiError(
                409,
                "The site clock is before this booking. Cancellation was not saved.",
            );
        if (now >= match.startsAt)
            throw new apiError(409, "This booking can no longer be changed.");

        const refundAmount = getRefundAmount(match, booking, now);
        const cancelled = await Booking.updateOne(
            { _id: bookingId, userId, status: "booked" },
            { $set: { status: "cancelled", refundAmount, cancelledAt: now } },
            { session },
        );

        if (cancelled.modifiedCount !== 1)
            throw new apiError(409, "This booking is already cancelled.");

        const inventory = await Match.updateOne(
            { _id: match._id, sold: { $gte: booking.quantity } },
            { $inc: { sold: -booking.quantity } },
            { session },
        );

        if (inventory.modifiedCount !== 1)
            throw new apiError(
                409,
                "Ticket inventory is inconsistent. Cancellation was not saved.",
            );

        await Outbox.create(
            [
                {
                    to: (await User.findById(userId).session(session).lean()).email,
                    subject: `Booking cancelled: ${booking.code}`,
                    body: `${booking.code}: ${match.title} cancelled. ${booking.quantity} ticket(s) returned. Refund INR ${refundAmount}.`,
                    type: "cancellation",
                    relatedBookingId: booking._id,
                    createdAt: now,
                },
            ],
            { session },
        );

        return { ...booking, status: "cancelled", refundAmount, cancelledAt: now };
    });
}
