import asyncHandler from "../utils/asyncHandler.js";
import apiError from "../utils/apiError.js";
import { Match } from "../site/models/match.model.js";
import { getMatchStatus } from "../site/lib/clock.js";
import { validId } from "../site/middleware/page-context.js";

export const sports = ["cricket", "tennis", "badminton", "football"];
const statuses = ["live", "upcoming", "past"];
const literalRegex = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

function readFilters(query) {
    const filters = {};

    for (const key of ["status", "sport", "location", "q"]) {
        const value = query[key] ?? "";

        if (typeof value !== "string" || value.length > 160)
            throw new apiError(400, "Use one short value for each search filter.");

        filters[key] = value.trim();
    }

    if (filters.status && !statuses.includes(filters.status))
        throw new apiError(400, "Choose Live, Upcoming, Past, or all matches.");

    if (filters.sport && !sports.includes(filters.sport))
        throw new apiError(400, "Choose a supported sport.");

    return filters;
}

export function presentMatch(match, now) {
    if (![match.price, match.capacity, match.sold].every(Number.isFinite))
        throw new apiError(503, "The event catalogue is being updated. Please try again shortly.");

    return { ...match, status: getMatchStatus(match, now), remaining: match.capacity - match.sold };
}

export const listMatches = asyncHandler(async (req, res) => {
    const filters = readFilters(req.query);

    const query = {};
    const clauses = [];

    if (filters.sport) query.sport = filters.sport;

    if (filters.location)
        clauses.push({
            $or: ["city", "country", "venue"].map((field) => ({
                [field]: literalRegex(filters.location),
            })),
        });

    if (filters.q)
        clauses.push({
            $or: ["title", "participants", "competition"].map((field) => ({
                [field]: literalRegex(filters.q),
            })),
        });

    if (clauses.length) query.$and = clauses;

    const now = res.locals.now;

    if (filters.status === "upcoming") query.startsAt = { $gt: now };

    if (filters.status === "live") {
        query.startsAt = { $lte: now };
        query.endsAt = { $gt: now };
    }

    if (filters.status === "past") query.endsAt = { $lte: now };

    const records = await Match.find(query).sort({ startsAt: 1, _id: 1 }).lean();

    const matches = records.map((match) => presentMatch(match, now));
    const groups = (filters.status ? [filters.status] : statuses).map((status) => ({
        status,
        matches: matches.filter((match) => match.status === status),
    }));

    const statusUrl = (status) => {
        const params = new URLSearchParams({ ...filters, status });

        for (const [key, value] of [...params]) if (!value) params.delete(key);

        return `/matches${params.size ? `?${params}` : ""}`;
    };

    res.render("matches/index", {
        title: "Discover matches",
        filters,
        sports,
        groups,
        total: matches.length,
        statusUrl,
    });
});

export const showMatch = asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) throw new apiError(404, "This match could not be found.");

    const record = await Match.findById(req.params.id).lean();

    if (!record) throw new apiError(404, "This match could not be found.");

    res.render("matches/detail", {
        title: record.title,
        match: presentMatch(record, res.locals.now),
    });
});
