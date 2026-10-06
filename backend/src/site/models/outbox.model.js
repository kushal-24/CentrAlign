import mongoose, { Schema } from "mongoose";

const outboxSchema = new Schema(
    {
        to: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
        },

        subject: {
            type: String,
            required: true,
            trim: true,
        },

        body: {
            type: String,
            required: true,
        },

        type: {
            type: String,
            required: true,
            enum: ["booking_confirmation", "cancellation", "waitlist_joined", "issue_received"],
        },

        relatedBookingId: {
            type: Schema.Types.ObjectId,
            ref: "Booking",
            default: null,
            required: function () {
                return this.type === "booking_confirmation" || this.type === "cancellation";
            },
        },

        createdAt: {
            type: Date,
            required: true,
            immutable: true,
        },
    },
    { collection: "outbox" },
);

export const Outbox = mongoose.model("Outbox", outboxSchema);
