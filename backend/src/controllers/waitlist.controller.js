import asyncHandler from "../utils/asyncHandler.js";
import apiError from "../utils/apiError.js";
import { Match } from "../site/models/match.model.js";
import { presentMatch } from "./matches.controller.js";
import {
    requireMatchId,
    requireConfirmation,
    quantityField,
    formValues,
} from "../site/services/action-validation.js";
import { joinEventWaitlist } from "../site/services/waitlist.service.js";

async function getMatch(id, now) {
    requireMatchId(id);

    const match = await Match.findById(id).lean();

    if (!match) throw new apiError(404, "This match could not be found.");

    return presentMatch(match, now);
}

export const showWaitlistForm = asyncHandler(async (req, res) => {
    const match = await getMatch(req.params.id, res.locals.now);

    res.render("matches/waitlist", {
        title: "Join waitlist",
        match,
        values: { quantity: "1" },
        error: null,
    });
});

export const joinWaitlist = asyncHandler(async (req, res) => {
    requireMatchId(req.params.id);

    try {
        const quantity = quantityField(req.body);

        requireConfirmation(req.body);

        const entry = await joinEventWaitlist(req.params.id, res.locals.user, quantity);

        res.redirect(303, `/bookings?joined=${entry._id}#waitlist-title`);
    } catch (error) {
        if (!(error instanceof apiError) || ![400, 409].includes(error.statusCode)) throw error;

        const match = await getMatch(req.params.id, res.locals.now);

        res.status(error.statusCode).render("matches/waitlist", {
            title: "Join waitlist",
            match,
            values: formValues(req.body, ["quantity", "confirm"]),
            error: error.message,
        });
    }
});
