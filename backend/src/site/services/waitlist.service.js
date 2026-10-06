import mongoose from "mongoose";
import apiError from "../../utils/apiError.js";
import { Match, Waitlist, Outbox } from "../models/index.js";
import { getNow } from "../lib/clock.js";
import { requireBookable } from "./action-validation.js";

export async function joinEventWaitlist(matchId, user, quantity) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await mongoose.connection.transaction(async (session) => {
                const now = await getNow();
                const match = await Match.findById(matchId).session(session).lean();

                requireBookable(match, now, quantity);

                if (match.capacity - match.sold >= quantity)
                    throw new apiError(409, "Tickets are still available. Please book instead.");

                const existing = await Waitlist.findOne({ matchId, userId: user._id })
                    .session(session)
                    .lean();

                if (existing)
                    throw new apiError(
                        409,
                        `You are already on the waitlist (position ${existing.position}).`,
                    );

                const position = (await Waitlist.countDocuments({ matchId }).session(session)) + 1;
                const [entry] = await Waitlist.create(
                    [{ matchId, userId: user._id, quantity, position, createdAt: now }],
                    { session },
                );

                await Outbox.create(
                    [
                        {
                            to: user.email,
                            subject: `Waitlist joined: ${match.title}`,
                            body: `${match.title}: ${quantity} ticket(s) requested. Your waitlist position is ${position}. No seats have been reserved.`,
                            type: "waitlist_joined",
                            relatedBookingId: null,
                            createdAt: now,
                        },
                    ],
                    { session },
                );

                return entry;
            });
        } catch (error) {
            if (error.code !== 11000) throw error;

            if (error.keyPattern?.position && attempt < 2) continue;

            throw new apiError(
                409,
                "You are already on the waitlist, or the queue is busy. Check My Bookings before trying again.",
            );
        }
    }
}
