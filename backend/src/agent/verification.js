import { Booking, Match, Waitlist, Outbox, User, Config } from "../site/models/index.js";

function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

export async function readActionState(account) {
    const [user, clock, matches, bookings, waitlist, outbox] = await Promise.all([
        User.findById(account.userId).select("_id name email phone").lean(),
        Config.findOne({ key: "mockNow" }).lean(),
        Match.find({}).sort({ _id: 1 }).limit(201).lean(),
        Booking.find({ userId: account.userId }).sort({ _id: 1 }).limit(201).lean(),
        Waitlist.find({ userId: account.userId }).sort({ _id: 1 }).limit(201).lean(),
        Outbox.find({ to: account.email }).sort({ _id: 1 }).limit(201).lean(),
    ]);
    if (!user || !clock || [matches, bookings, waitlist, outbox].some((rows) => rows.length > 200))
        throw new Error("Verification baseline unavailable or exceeds its record limit.");

    const result = { user, now: clock.value, matches, bookings, waitlist, outbox };
    if (JSON.stringify(result).length > 200000) throw new Error("Verification baseline too large.");
    return JSON.parse(JSON.stringify(result));
}

export function describeAction(details, before) {
    const path = new URL(details.destination).pathname;
    const fields = Object.fromEntries(details.values);
    const matchRoute = path.match(/^\/matches\/([a-f\d]{24})\/(book|waitlist)$/i);
    const cancelRoute = path.match(/^\/bookings\/([a-f\d]{24})\/cancel$/i);
    if (details.method.toLowerCase() !== "post") throw new Error("Unsupported action method.");

    if (path === "/profile")
        return { kind: "profile", name: fields.name?.trim(), phone: fields.phone?.trim() };
    const booking = cancelRoute && before.bookings.find((row) => row._id === cancelRoute[1]);
    const matchId = matchRoute?.[1] ?? booking?.matchId;
    const match = before.matches.find((row) => row._id === matchId);
    if (!match) throw new Error("Action target is not an observed match or owned booking.");
    const quantity = booking?.quantity ?? Number(fields.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1)
        throw new Error("Invalid action quantity.");

    const now = new Date(before.now).getTime();
    const refund =
        booking &&
        match.refundFullHoursBefore !== null &&
        now <= new Date(match.startsAt).getTime() - match.refundFullHoursBefore * 3600000
            ? booking.totalPrice
            : 0;
    const conflicts = before.bookings
        .filter((row) => row.status === "booked" && row.matchId !== matchId)
        .flatMap((row) => {
            const other = before.matches.find((event) => event._id === row.matchId);
            return other &&
                new Date(other.startsAt) < new Date(match.endsAt) &&
                new Date(match.startsAt) < new Date(other.endsAt)
                ? [
                      {
                          bookingId: row._id,
                          title: other.title,
                          startsAt: other.startsAt,
                          endsAt: other.endsAt,
                      },
                  ]
                : [];
        });

    return {
        kind: cancelRoute ? "cancel" : matchRoute[2],
        matchId,
        bookingId: booking?._id,
        title: match.title,
        quantity,
        total: match.price * quantity,
        refund: booking ? refund : undefined,
        ownerName: fields.ownerName?.trim(),
        ownerEmail: fields.ownerEmail?.trim().toLowerCase(),
        conflicts,
        policy: match.policyText,
    };
}

export function checkAction(before, after, action, account) {
    const checks = [];
    const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
    const added = (name) =>
        after[name].filter((row) => !before[name].some((old) => old._id === row._id));
    const matchBefore = before.matches.find((row) => row._id === action.matchId);
    const matchAfter = after.matches.find((row) => row._id === action.matchId);
    let record;
    let receipt;
    let changedBooking;
    let delta = 0;

    check("site clock unchanged during action", before.now === after.now);
    if (action.kind === "profile") {
        check(
            "profile matches approved fields",
            after.user.name === action.name && after.user.phone === action.phone,
        );
        check(
            "identity and email unchanged",
            after.user._id === before.user._id && after.user.email === before.user.email,
        );
        record = after.user;
    } else {
        check("profile unchanged", same(before.user, after.user));
        check("target event exists", matchBefore && matchAfter);
    }

    if (action.kind === "book") {
        const rows = added("bookings");
        record = rows[0];
        check(
            "exactly one intended booking",
            rows.length === 1 &&
                record?.matchId === action.matchId &&
                record?.userId === account.userId,
        );
        check(
            "approved attendee, quantity and cost",
            record?.ownerName === action.ownerName &&
                record?.ownerEmail === action.ownerEmail &&
                record?.quantity === action.quantity &&
                record?.totalPrice === action.total &&
                record?.status === "booked" &&
                record?.createdAt === new Date(before.now).toISOString(),
        );
        receipt = added("outbox").find(
            (row) => row.relatedBookingId === record?._id && row.type === "booking_confirmation",
        );
        check(
            "matching booking receipt",
            receipt?.to === account.email &&
                receipt?.subject.includes(record?.code) &&
                receipt?.body.includes(`Total INR ${action.total}`),
        );
        delta = action.quantity;
    }
    if (action.kind === "cancel") {
        const old = before.bookings.find((row) => row._id === action.bookingId);
        record = after.bookings.find((row) => row._id === action.bookingId);
        changedBooking = action.bookingId;
        check(
            "owned booking cancelled with approved refund",
            old?.status === "booked" &&
                record?.status === "cancelled" &&
                record?.refundAmount === action.refund &&
                record?.cancelledAt === new Date(before.now).toISOString(),
        );
        check(
            "booking identity, attendee and quantity unchanged",
            same(old, {
                ...record,
                status: old?.status,
                refundAmount: old?.refundAmount,
                cancelledAt: old?.cancelledAt,
            }),
        );
        receipt = added("outbox").find(
            (row) => row.relatedBookingId === action.bookingId && row.type === "cancellation",
        );
        check(
            "matching cancellation receipt",
            receipt?.to === account.email &&
                receipt?.subject.includes(record?.code) &&
                receipt?.body.includes(`Refund INR ${action.refund}`),
        );
        delta = -action.quantity;
    }
    if (action.kind === "waitlist") {
        const rows = added("waitlist");
        record = rows[0];
        check(
            "exactly one intended waitlist entry",
            rows.length === 1 &&
                record?.matchId === action.matchId &&
                record?.userId === account.userId &&
                record?.quantity === action.quantity &&
                Number.isSafeInteger(record?.position) &&
                record.position > 0,
        );
        check(
            "expected queue position and timestamp",
            record?.position === action.expectedPosition &&
                record?.createdAt === new Date(before.now).toISOString(),
        );
        receipt = added("outbox").find(
            (row) =>
                row.type === "waitlist_joined" &&
                row.subject === `Waitlist joined: ${action.title}`,
        );
        check(
            "matching waitlist receipt",
            receipt?.to === account.email &&
                receipt?.body.includes(`${action.quantity} ticket(s) requested`) &&
                receipt?.body.includes(`position is ${record?.position}`),
        );
    }

    const expectedMatches = before.matches.map((row) =>
        row._id === action.matchId ? { ...row, sold: row.sold + delta } : row,
    );
    check("only expected inventory changed", same(expectedMatches, after.matches));
    const expectedBookings = after.bookings.filter(
        (row) => row._id !== changedBooking && !(action.kind === "book" && row._id === record?._id),
    );
    check(
        "no unrelated booking changed",
        same(
            before.bookings.filter((row) => row._id !== changedBooking),
            expectedBookings,
        ),
    );
    check(
        "no unrelated waitlist changed",
        same(
            before.waitlist,
            after.waitlist.filter(
                (row) => !(action.kind === "waitlist" && row._id === record?._id),
            ),
        ),
    );
    check(
        "only the intended receipt added",
        same(
            before.outbox,
            after.outbox.filter((row) => row._id !== receipt?._id),
        ) &&
            (action.kind === "profile"
                ? added("outbox").length === 0
                : added("outbox").length === 1),
    );

    return {
        success: checks.every((entry) => entry.passed),
        checks,
        action,
        records: record ? [record] : [],
        outbox: receipt ? [receipt] : [],
    };
}

export function createActionVerifier(account, options = {}) {
    const readState = options.readState ?? (() => readActionState(account));
    const actions = new Map();

    async function capture(proposalId, details) {
        if (!actions.has(proposalId)) {
            if ([...actions.values()].some((entry) => entry.approved))
                throw new Error(
                    "Only one persisted action is supported per task. Finish and verify the current action first.",
                );
            const before = await readState();
            const action = describeAction(details, before);
            if (action.kind === "waitlist")
                action.expectedPosition =
                    (await (
                        options.queueCount ?? ((matchId) => Waitlist.countDocuments({ matchId }))
                    )(action.matchId)) + 1;
            actions.set(proposalId, {
                before,
                action,
                approved: false,
            });
        }
        return actions.get(proposalId).action;
    }

    async function approve(proposalId) {
        const entry = actions.get(proposalId);
        if (!entry || !same(entry.before, await readState()))
            throw new Error(
                "Action proposal changed in the database. Start with fresh details and approval.",
            );
        entry.approved = true;
    }

    async function verifyActions() {
        const entries = [...actions.values()].filter((entry) => entry.approved);
        if (!entries.length)
            return {
                success: false,
                checks: [{ name: "approved action evidence exists", passed: false }],
                actions: [],
            };
        const after = await readState();
        // This initial slice supports one persisted action per task; do not silently verify a partial batch.
        if (entries.length !== 1)
            return {
                success: false,
                checks: [{ name: "single approved action per task", passed: false }],
                actions: [],
            };
        const result = checkAction(entries[0].before, after, entries[0].action, account);
        return {
            success: result.success,
            checks: result.checks,
            actions: [{ ...result, approved: true }],
        };
    }

    return { capture, approve, verifyActions };
}
