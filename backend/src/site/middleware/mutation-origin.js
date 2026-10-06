import apiError from "../../utils/apiError.js";

export function mutationOrigin(req, res, next) {
    const origin = req.get("origin");
    const expected = `${req.protocol}://${req.get("host")}`;

    if (req.get("sec-fetch-site") === "cross-site" || (origin && origin !== expected)) {
        return next(new apiError(403, "Submit this form from MatchDay."));
    }

    next();
}
