import mongoose from "mongoose";
import * as models from "../../src/site/models/index.js";
import { buildSeedData } from "../../src/site/seed/data.js";

const equal = (left, right) => left?.toString() === right?.toString();
function matches(record, query) {
    return Object.entries(query).every(([key, value]) => {
        if (key === "$and") return value.every((clause) => matches(record, clause));
        if (key === "$or") return value.some((clause) => matches(record, clause));
        const actual = record[key];
        if (value instanceof RegExp) return value.test(actual);
        if (
            value &&
            typeof value === "object" &&
            !(value instanceof mongoose.Types.ObjectId) &&
            !(value instanceof Date)
        ) {
            return Object.entries(value).every(([operator, target]) => {
                if (operator === "$in") return target.some((item) => equal(actual, item));
                if (operator === "$gt") return actual > target;
                if (operator === "$lte") return actual <= target;
                throw new Error(`Unsupported fixture operator: ${operator}`);
            });
        }
        return equal(actual, value);
    });
}

export function installSiteFixture(mock) {
    const data = buildSeedData("student@example.com");
    const state = { data, failure: false };
    const initialState = mongoose.connection.readyState;
    mongoose.connection.readyState = 1;
    for (const [name, collection] of Object.entries({
        User: "users",
        Match: "matches",
        Booking: "bookings",
        Waitlist: "waitlist",
        Outbox: "outbox",
        Config: "config",
    })) {
        const query = (filter, single) => {
            let order = {};
            return {
                session() {
                    return this;
                },
                sort(sort) {
                    order = sort;
                    return this;
                },
                async lean() {
                    if (state.failure) throw new Error("private database error");
                    const records = data[collection].filter((record) => matches(record, filter));
                    records.sort((left, right) => {
                        for (const [key, direction] of Object.entries(order)) {
                            const a =
                                left[key] instanceof Date
                                    ? left[key].getTime()
                                    : left[key]?.toString();
                            const b =
                                right[key] instanceof Date
                                    ? right[key].getTime()
                                    : right[key]?.toString();
                            if (a !== b) return (a < b ? -1 : 1) * direction;
                        }
                        return 0;
                    });
                    return single ? (records[0] ?? null) : records;
                },
            };
        };
        mock.method(models[name], "find", (filter = {}) => query(filter, false));
        mock.method(models[name], "findOne", (filter = {}) => query(filter, true));
        mock.method(models[name], "findById", (id) => query({ _id: id }, true));
    }
    state.restore = () => {
        mock.restoreAll();
        mongoose.connection.readyState = initialState;
    };
    return state;
}
