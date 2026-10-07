import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Types } from "mongoose";
import { User, Match, Booking, Waitlist, Outbox, Config } from "../../site/models/index.js";
import { isValidClockTime } from "../../site/models/config.model.js";

const collections = {
    users: User,
    matches: Match,
    bookings: Booking,
    waitlist: Waitlist,
    outbox: Outbox,
    config: Config,
};
const fields = {
    users: "_id name email phone",
    matches:
        "_id sport title competition participants venue city country startsAt endsAt displayTime price capacity sold perBookingLimit isFree bookingStatus policyText refundFullHoursBefore",
    bookings:
        "_id code matchId userId ownerName ownerEmail quantity totalPrice status refundAmount createdAt cancelledAt",
    waitlist: "_id matchId userId quantity position createdAt",
    outbox: "_id to subject body type relatedBookingId createdAt",
    config: "_id key value",
};

export const querySchema = z
    .object({
        collection: z.enum(["users", "matches", "bookings", "waitlist", "outbox", "config"]),
        filter: z
            .string()
            .max(4000)
            .default("{}")
            .describe(
                'JSON filter, e.g. {"sport":"cricket","price":{"$lte":1000}}. Read only; $contains is literal case-insensitive text search.',
            ),
        limit: z.number().int().min(1).max(20).default(10),
        projection: z.array(z.string().max(40)).max(25).optional(),
        sort: z
            .object({ field: z.string().max(40), direction: z.enum(["asc", "desc"]) })
            .strict()
            .optional(),
    })
    .strict();

function validateValue(value, path) {
    if (value === null) return null;

    if (path.instance === "ObjectId") {
        if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value))
            throw new Error(
                "Record IDs must be 24 hexadecimal characters. Config settings use key, not _id.",
            );
        return new Types.ObjectId(value);
    }
    if (path.instance === "Date") {
        if (!isValidClockTime(value))
            throw new Error("Dates must be valid ISO timestamps with timezone.");
        return new Date(value);
    }
    if (path.instance === "Number") {
        if (typeof value !== "number" || !Number.isFinite(value))
            throw new Error("Expected a finite number.");
        return value;
    }
    if (path.instance === "Boolean") {
        if (typeof value !== "boolean") throw new Error("Expected a boolean.");
        return value;
    }
    if (typeof value !== "string" || value.length > 500) throw new Error("Expected bounded text.");
    return value;
}

export function validateFilter(filter, collection, depth = 0) {
    if (
        !filter ||
        Array.isArray(filter) ||
        typeof filter !== "object" ||
        depth > 3 ||
        Object.keys(filter).length > 15
    )
        throw new Error("Invalid or excessive query filter.");

    const result = {};
    const allowed = fields[collection].split(" ");
    for (const [field, condition] of Object.entries(filter)) {
        if (["$and", "$or"].includes(field)) {
            if (!Array.isArray(condition) || !condition.length || condition.length > 5)
                throw new Error("Invalid logical filter.");
            result[field] = condition.map((entry) => validateFilter(entry, collection, depth + 1));
            continue;
        }
        if (!allowed.includes(field)) throw new Error("Unsupported query field.");
        const path = collections[collection].schema.path(field);

        if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
            const operators = Object.entries(condition);
            if (!operators.length || operators.length > 4) throw new Error("Invalid comparison.");
            result[field] = {};
            for (const [operator, value] of operators) {
                if (operator === "$contains") {
                    if (
                        path.instance !== "String" ||
                        typeof value !== "string" ||
                        !value.length ||
                        value.length > 100
                    )
                        throw new Error("Literal search requires bounded text.");
                    result[field].$regex = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    result[field].$options = "i";
                } else if (operator === "$in") {
                    if (!Array.isArray(value) || !value.length || value.length > 10)
                        throw new Error("Invalid membership filter.");
                    result[field][operator] = value.map((item) => validateValue(item, path));
                } else if (["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"].includes(operator)) {
                    result[field][operator] = validateValue(value, path);
                } else {
                    throw new Error("Unsupported query operator.");
                }
            }
        } else {
            result[field] = validateValue(condition, path);
        }
    }
    return result;
}

export function validateQuery(input) {
    const query = querySchema.parse(input);
    const allowed = fields[query.collection].split(" ");
    const projection = query.projection ?? allowed;
    if (!projection.length || projection.some((field) => !allowed.includes(field)))
        throw new Error("Unsupported projection field.");
    if (query.sort && !allowed.includes(query.sort.field))
        throw new Error("Unsupported sort field.");

    return {
        ...query,
        filter: validateFilter(JSON.parse(query.filter), query.collection),
        projection,
    };
}

export function serializeRecords(records) {
    const result = [];
    let bytes = 0;
    for (const record of records) {
        const text = JSON.stringify(record);
        if (bytes + Buffer.byteLength(text) > 24000) break;
        result.push(JSON.parse(text));
        bytes += Buffer.byteLength(text);
    }
    return { records: result, truncated: result.length < records.length };
}

export function createDbTool(account, options = {}) {
    if (!/^[a-f\d]{24}$/i.test(String(account.userId)) || typeof account.email !== "string")
        throw new Error("Trusted account is required.");

    return tool(
        async (input) => {
            let query;
            try {
                query = validateQuery(input);
            } catch (error) {
                return JSON.stringify({
                    success: false,
                    observation: error.message.startsWith("Record IDs must")
                        ? error.message
                        : 'Invalid read query. Check allowed fields, operators, types and limits. Clock filter: {"key":"mockNow"}. Exact sports are lowercase: cricket, football, tennis, badminton.',
                });
            }

            const scope =
                query.collection === "users"
                    ? { _id: new Types.ObjectId(account.userId) }
                    : ["bookings", "waitlist"].includes(query.collection)
                      ? { userId: new Types.ObjectId(account.userId) }
                      : query.collection === "outbox"
                        ? { to: account.email }
                        : {};
            const filter = { $and: [scope, query.filter] };
            const sort = query.sort
                ? { [query.sort.field]: query.sort.direction === "asc" ? 1 : -1 }
                : { _id: 1 };

            try {
                const model = options.models?.[query.collection] ?? collections[query.collection];
                const records = await model
                    .find(filter)
                    .select(query.projection.join(" "))
                    .sort(sort)
                    .limit(query.limit)
                    .maxTimeMS(3000)
                    .lean();
                return JSON.stringify({
                    success: true,
                    collection: query.collection,
                    limit: query.limit,
                    ...serializeRecords(records),
                    observation:
                        "Read-only records; use config mockNow for business time. Results are bounded, not an exhaustive count.",
                });
            } catch {
                return JSON.stringify({
                    success: false,
                    observation: "Database read unavailable. No site records were changed.",
                });
            }
        },
        {
            name: "db_query",
            description: `Read only ${Object.keys(collections).join(", ")}. Private records are scoped to your account. Filter is JSON text, never writes or arbitrary regex. Allowed fields: ${JSON.stringify(fields)}. Clock query: collection "config", filter '{"key":"mockNow"}', limit 1. _id requires a 24-character hexadecimal record ID. Exact sport values: cricket, football, tennis, badminton. Use $contains for literal case-insensitive text search. Empty results may require broader discovery or alternate spelling.`,
            schema: querySchema,
        },
    );
}
