import asyncHandler from "../utils/asyncHandler.js";
import apiError from "../utils/apiError.js";
import { User } from "../site/models/user.model.js";
import { textField, formValues } from "../site/services/action-validation.js";

export const showProfile = (req, res) => {
    res.render("profile/index", {
        title: "My profile",
        values: res.locals.user,
        error: null,
        saved: req.query.saved === "1",
    });
};

export const updateProfile = asyncHandler(async (req, res) => {
    try {
        if (Object.keys(req.body ?? {}).some((key) => !["name", "phone"].includes(key))) {
            throw new apiError(400, "Only your name and phone number can be edited.");
        }

        const name = textField(req.body, "name", "name");
        const phone = textField(req.body, "phone", "phone number", 16);

        if (!/^\+?[1-9]\d{6,14}$/.test(phone))
            throw new apiError(400, "Enter a valid phone number, including the country code.");

        const user = await User.findOneAndUpdate(
            { _id: res.locals.user._id },
            { $set: { name, phone } },
            { new: true, runValidators: true },
        );

        if (!user) throw new apiError(401, "Your demo session is unavailable.");

        res.redirect(303, "/profile?saved=1");
    } catch (error) {
        if (!(error instanceof apiError) || error.statusCode !== 400) throw error;

        res.status(400).render("profile/index", {
            title: "My profile",
            values: formValues(req.body, ["name", "phone"]),
            error: error.message,
            saved: false,
        });
    }
});
