import mongoose, { Schema } from "mongoose";

const bookingSchema = new Schema({
    code: {
        type: String,
        required: true,
    },

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

    ownerName: {
        type: String,
        required: true,
        trim: true,
    },

    ownerEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },

    // Bonus features to be looked on later: ticket tiers.
    // tier: {
    //     type: String,
    //     required: true,
    //     trim: true,
    // },
    //
    quantity: {
        type: Number,
        required: true,
        min: 1,
        validate: Number.isSafeInteger,
    },

    totalPrice: {
        type: Number,
        required: true,
        min: 0,
        validate: Number.isFinite,
    },

    status: {
        type: String,
        required: true,
        enum: ["booked", "cancelled"],
    },

    refundAmount: {
        type: Number,
        default: 0,
        min: 0,
        validate: {
            validator: function (value) {
                if (!Number.isFinite(value) || value > this.totalPrice) return false;
                if (this.status === "booked") return value === 0;
                return true;
            },
            message: "Invalid booking refund",
        },
    },

    createdAt: {
        type: Date,
        required: true,
        immutable: true,
    },

    cancelledAt: {
        type: Date,
        default: null,
        validate: {
            validator: function (value) {
                if (this.status === "cancelled") {
                    return value !== null && value >= this.createdAt;
                }
                return value === null;
            },
            message: "Cancellation timestamp must agree with booking status",
        },
    },
});
bookingSchema.index({ code: 1 }, { unique: true });
// Only active bookings must be unique; a cancelled booking can be booked again.
bookingSchema.index(
    { userId: 1, matchId: 1 },
    { unique: true, partialFilterExpression: { status: "booked" } },
);

export const Booking = mongoose.model("Booking", bookingSchema);
