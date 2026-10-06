import mongoose, { Schema } from "mongoose";

const waitlistSchema = new Schema(
    {
        matchId: {
            type: Schema.Types.ObjectId,
            ref: "Match",
            required: true,
        },

        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        tier: {
            type: String,
            required: true,
            trim: true,
        },

        quantity: {
            type: Number,
            required: true,
            min: 1,
            validate: Number.isSafeInteger,
        },

        position: {
            type: Number,
            required: true,
            min: 1,
            validate: Number.isSafeInteger,
        },

        createdAt: {
            type: Date,
            required: true,
            immutable: true,
        },
    },
    { collection: "waitlist" },
);

waitlistSchema.index({ matchId: 1, userId: 1, tier: 1 }, { unique: true });
waitlistSchema.index({ matchId: 1, tier: 1, position: 1 }, { unique: true });

export const Waitlist = mongoose.model("Waitlist", waitlistSchema);
