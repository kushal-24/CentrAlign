import mongoose, { Schema } from "mongoose";

const tierSchema = new Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },

        price: {
            type: Number,
            required: true,
            min: 0,
            validate: Number.isFinite,
        },

        capacity: {
            type: Number,
            required: true,
            min: 1,
            validate: Number.isSafeInteger,
        },

        sold: {
            type: Number,
            required: true,
            min: 0,

            validate: [
                {
                    validator: Number.isSafeInteger,
                    message: "Sold quantity must be an integer",
                },
                {
                    validator: function (value) {
                        return value <= this.capacity;
                    },
                    message: "Sold quantity exceeds capacity",
                },
            ],
        },
    },
    {
        _id: false,
    }
);

const matchSchema = new Schema({
    sport: {
        type: String,
        required: true,
        enum: [
            "cricket",
            "tennis",
            "badminton",
            "football",
        ],
    },

    title: {
        type: String,
        required: true,
        trim: true,
    },

    competition: {
        type: String,
        required: true,
        trim: true,
    },

    participants: {
        type: String,
        required: true,
        trim: true,
    },

    venue: {
        type: String,
        required: true,
        trim: true,
    },

    city: {
        type: String,
        required: true,
        trim: true,
    },

    country: {
        type: String,
        required: true,
        trim: true,
    },

    startsAt: {
        type: Date,
        required: true,
    },

    endsAt: {
        type: Date,
        required: true,

        validate: {
            validator: function (value) {
                return value > this.startsAt;
            },

            message: "Match must end after it starts",
        },
    },

    displayTime: {
        type: String,
        required: true,
        trim: true,
    },

    tiers: {
        type: [tierSchema],
        required: true,

        validate: {
            validator: function (tiers) {
                const names = tiers.map((tier) => tier.name);

                return (
                    tiers.length > 0 &&
                    new Set(names).size === names.length
                );
            },

            message: "Ticket tiers must be nonempty and uniquely named",
        },
    },

    perBookingLimit: {
        type: Number,
        required: true,
        min: 1,
        validate: Number.isSafeInteger,
    },

    isFree: {
        type: Boolean,
        required: true,

        validate: {
            validator: function (value) {
                if (!value) return true;

                return this.tiers.every(
                    (tier) => tier.price === 0
                );
            },

            message: "Free event tiers must cost zero",
        },
    },

    bookingStatus: {
        type: String,
        required: true,
        enum: [
            "open",
            "postponed",
        ],
    },

    policyText: {
        type: String,
        required: true,
        trim: true,
    },

    refundFullHoursBefore: {
        type: Number,
        default: null,
        min: 0,

        validate: (value) => {
            return (
                value === null ||
                Number.isFinite(value)
            );
        },
    },
});

export const Match = mongoose.model(
    "Match",
    matchSchema
);