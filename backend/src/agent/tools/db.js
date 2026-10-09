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

class QueryValidationError extends Error {
    constructor(code, message, hint) {
        super(message);
        this.code = code;
        this.hint = hint;
    }
}

const invalidQuery = (code, message, hint) => new QueryValidationError(code, message, hint);
const label = (value) => JSON.stringify(String(value).slice(0, 80));

export function queryErrorObservation(error) {
    const known = error instanceof QueryValidationError;
    const message = known ? error.message : "Query validation failed.";
    const hint = known ? error.hint : "Check the advertised query schema and allowed fields.";
    return {
        success: false,
        errorCode: known ? error.code : "INVALID_QUERY",
        message,
        hint,
        observation: `${message} ${hint}`,
    };
}

function validateValue(value, path) {
    if (value === null) return null;

    if (path.instance === "ObjectId") {
        if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value))
            throw invalidQuery("INVALID_RECORD_ID", "Record IDs must be 24 hexadecimal characters.", "Use an observed record ID. Config settings use key, not _id.");
        return new Types.ObjectId(value);
    }
    if (path.instance === "Date") {
        if (!isValidClockTime(value))
            throw invalidQuery("INVALID_DATE", `Field ${label(path.path)} requires a valid ISO timestamp with timezone.`, "Supply an ISO date and time including Z or a timezone offset.");
        return new Date(value);
    }
    if (path.instance === "Number") {
        if (typeof value !== "number" || !Number.isFinite(value))
            throw invalidQuery("INVALID_NUMBER", `Field ${label(path.path)} requires a finite number.`, "Supply a JSON number, not quoted text.");
        return value;
    }
    if (path.instance === "Boolean") {
        if (typeof value !== "boolean") throw invalidQuery("INVALID_BOOLEAN", `Field ${label(path.path)} requires a boolean.`, "Supply true or false, not quoted text.");
        return value;
    }
    if (typeof value !== "string" || value.length > 500) throw invalidQuery("INVALID_TEXT", `Field ${label(path.path)} requires text of at most 500 characters.`, "Supply a JSON string within the field limit.");
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
        throw invalidQuery("INVALID_FILTER", "Invalid or excessive query filter.", "Use an object with at most 15 keys per level and nesting depth at most 3.");

    const result = {};
    const allowed = fields[collection].split(" ");
    for (const [field, condition] of Object.entries(filter)) {
        if (["$and", "$or"].includes(field)) {
            if (!Array.isArray(condition) || !condition.length || condition.length > 5)
                throw invalidQuery("INVALID_LOGICAL_FILTER", `Invalid logical filter ${label(field)}.`, "Use an array containing 1 to 5 filter objects.");
            result[field] = condition.map((entry) => validateFilter(entry, collection, depth + 1));
            continue;
        }
        if (!allowed.includes(field)) throw invalidQuery("UNSUPPORTED_FIELD", `Unsupported top-level field or operator ${label(field)}.`, field.startsWith("$") ? "Only $and and $or are top-level operators. Place comparison/search operators inside an allowed field condition." : `Use allowed fields for ${collection}: ${fields[collection]}.`);
        const path = collections[collection].schema.path(field);

        if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
            const operators = Object.entries(condition);
            if (!operators.length || operators.length > 4) throw invalidQuery("INVALID_COMPARISON", `Invalid comparison for field ${label(field)}.`, "Use 1 to 4 supported operators inside the field condition.");
            result[field] = {};
            for (const [operator, value] of operators) {
                if (operator === "$contains") {
                    if (
                        path.instance !== "String" ||
                        typeof value !== "string" ||
                        !value.length ||
                        value.length > 100
                    )
                        throw invalidQuery("INVALID_TEXT_SEARCH", `Invalid $contains condition for field ${label(field)}.`, "Use $contains only inside a String field condition, with a nonempty string of at most 100 characters.");
                    result[field].$regex = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    result[field].$options = "i";
                } else if (operator === "$in") {
                    if (!Array.isArray(value) || !value.length || value.length > 10)
                        throw invalidQuery("INVALID_MEMBERSHIP", `Invalid $in condition for field ${label(field)}.`, "Supply an array of 1 to 10 values matching the field type.");
                    result[field][operator] = value.map((item) => validateValue(item, path));
                } else if (["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"].includes(operator)) {
                    result[field][operator] = validateValue(value, path);
                } else {
                    throw invalidQuery("UNSUPPORTED_OPERATOR", `Unsupported operator ${label(operator)} for field ${label(field)}.`, "Supported field operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $contains. Use $contains for literal text search; arbitrary regex is not allowed.");
                }
            }
        } else {
            result[field] = validateValue(condition, path);
        }
    }
    return result;
}

export function validateQuery(input) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw invalidQuery("INVALID_QUERY_ARGUMENTS", `Invalid query argument ${label(issue.path.join(".") || "query")}: ${issue.message}`, "Follow the advertised query schema: filter is JSON text, limit is 1 to 20, projection uses allowed fields, and sort direction is asc or desc.");
    }
    const query = parsed.data;
    const allowed = fields[query.collection].split(" ");
    const projection = query.projection ?? allowed;
    if (!projection.length || projection.some((field) => !allowed.includes(field)))
        throw invalidQuery("INVALID_PROJECTION", "Unsupported or empty projection.", `Choose at least one allowed field for ${query.collection}: ${fields[query.collection]}.`);
    if (query.sort && !allowed.includes(query.sort.field))
        throw invalidQuery("INVALID_SORT", `Unsupported sort field ${label(query.sort.field)}.`, `Choose an allowed field for ${query.collection}: ${fields[query.collection]}.`);

    let filter;
    try {
        filter = JSON.parse(query.filter);
    } catch {
        throw invalidQuery("INVALID_JSON", "Filter is not valid JSON.", "Provide a JSON object encoded as text, with double-quoted keys and string values.");
    }
    return {
        ...query,
        filter: validateFilter(filter, query.collection),
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
                return JSON.stringify(queryErrorObservation(error));
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
                    errorCode: "DATABASE_READ_UNAVAILABLE",
                    message: "Database read unavailable; the underlying cause is unknown.",
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
