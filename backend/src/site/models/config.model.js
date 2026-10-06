import mongoose, { Schema } from "mongoose";

export function isValidClockTime(value) {
    if (typeof value !== "string") return false;
    const isoFormat =
        /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
    if (!isoFormat.test(value) || Number.isNaN(Date.parse(value))) return false;

    // Date parsing can normalize February 30; check the supplied calendar date too.
    const calendarDate = value.slice(0, 10);
    const parsedDate = new Date(`${calendarDate}T00:00:00Z`);
    return (
        !Number.isNaN(parsedDate.getTime()) &&
        parsedDate.toISOString().slice(0, 10) === calendarDate
    );
}
const configSchema = new Schema(
    {
        key: {
            type: String,
            required: true,
            enum: ["mockNow"],
        },

        value: {
            type: String,
            required: true,
            validate: {
                validator: isValidClockTime,
                message: "Clock time must be a valid ISO timestamp with a timezone",
            },
        },
    },
    { collection: "config" },
);
configSchema.index({ key: 1 }, { unique: true });

export const Config = mongoose.model("Config", configSchema);
