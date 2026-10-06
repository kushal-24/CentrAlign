import mongoose, { Schema } from "mongoose";

const userSchema = new Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },

    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },

    phone: {
        type: String,
        required: true,
        match: /^\+?[1-9]\d{6,14}$/,
    },
});
userSchema.index({ email: 1 }, { unique: true });

export const User = mongoose.model("User", userSchema);
