import asyncHandler from "../utils/asyncHandler.js";
import apiError from "../utils/apiError.js";
import { User } from "../site/models/user.model.js";
import { readConfig } from "../config.js";

const cookieOptions = { httpOnly: true, sameSite: "lax", path: "/" };

export const openDemoSession = asyncHandler(async (req, res) => {
    const config = readConfig(process.env, { requireStudent: true });
    const user = await User.findOne({ email: config.STUDENT_EMAIL.trim().toLowerCase() }).lean();

    if (!user)
        throw new apiError(
            503,
            "The demo user is unavailable. Please seed the demo database first.",
        );

    res.cookie("uid", user._id.toString(), cookieOptions);
    res.redirect(303, "/bookings");
});

export const closeDemoSession = (req, res) => {
    res.clearCookie("uid", cookieOptions);
    res.redirect(303, "/matches");
};
