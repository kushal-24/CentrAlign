import { Booking, Match, Waitlist, Outbox, User, Config } from "../site/models/index.js";
import fuzzysort from "fuzzysort";
import { getRefundAmount } from "../site/lib/clock.js";

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
    let resolvedCancellation = null;
    let chosenCode = null;

    async function prepareCancellation(selection) {
        if (options.task && selection.bookingCode &&
            !(options.task.match(/\bMD-[A-Z0-9]+\b/gi) ?? []).some((code) =>
                code.toUpperCase() === selection.bookingCode.toUpperCase()) &&
            chosenCode !== selection.bookingCode)
            throw new Error("Search by event first. A discovered booking code requires the user's choice when ambiguous.");
        resolvedCancellation = cancellationDetails(await readState(), selection, account);
        return resolvedCancellation;
    }

    function acceptCancellationChoice(answer, choices = []) {
        if (resolvedCancellation?.status === "ambiguous" && choices.includes(answer) &&
            resolvedCancellation.candidates.some((row) => row.bookingCode === answer))
            chosenCode = answer;
    }

    async function capture(proposalId, details) {
        if (!actions.has(proposalId)) {
            if ([...actions.values()].some((entry) => entry.approved))
                throw new Error(
                    "Only one persisted action is supported per task. Finish and verify the current action first.",
                );
            const before = await readState();
            const action = describeAction(details, before);
            if (action.kind === "cancel" && options.task && /\bcancel\b/i.test(options.task)) {
                if (resolvedCancellation?.status !== "ready" ||
                    !before.bookings.some((row) => row._id === action.bookingId && row.status === "booked") ||
                    action.bookingId !== resolvedCancellation.bookingId ||
                    action.matchId !== resolvedCancellation.matchId ||
                    action.refund !== resolvedCancellation.refund || before.now !== resolvedCancellation.siteTime)
                    throw new Error("Resolve the intended active booking and current refund before requesting approval.");
            }
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

    async function verifyExistingCancellation(task, bookingCode) {
        const state = await readState();
        let resolution = resolvedCancellation;
        if (!resolution) {
            const codes = task.match(/\bMD-[A-Z0-9]+\b/gi) ?? [];
            if (codes.length === 1)
                resolution = cancellationDetails(state, { bookingCode: codes[0] }, account);
        }
        // Re-resolve the original search so a newly active booking cannot be hidden by an old cancellation.
        if (resolution?.status === "already_cancelled") {
            const refreshed = cancellationDetails(state, resolution.explicitBookingCode
                ? { bookingCode: resolution.bookingCode }
                : { eventSearch: resolution.eventSearch }, account);
            if (refreshed.status !== "already_cancelled" || refreshed.bookingId !== resolution.bookingId)
                resolution = null;
        }
        return checkExistingCancellation(state, task, bookingCode, account, resolution);
    }

    return { capture, approve, verifyActions, verifyExistingCancellation, prepareCancellation,
        acceptCancellationChoice, getCancellationQuote: () => resolvedCancellation };
}

export function cancellationDetails(state, selection, account) {
    const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const owned = state.bookings.filter((row) => row.userId === account.userId);
    let events;
    let uncertainEvent = false;
    if (selection.bookingCode) {
        const booking = owned.find((row) => row.code.toUpperCase() === selection.bookingCode.toUpperCase());
        events = state.matches.filter((row) => row._id === booking?.matchId);
    } else {
        const query = normalize(selection.eventSearch ?? "");
        if (!query) return { status: "not_found", candidates: [] };
        const searchable = state.matches.filter((event) => owned.some((row) => row.matchId === event._id))
            .map((event) => ({ ...event, searchTitle: normalize(event.title) }));
        const ranked = fuzzysort.go(query, searchable, { key: "searchTitle", threshold: 0.5 });
        uncertainEvent = ranked.length > 0 && ranked[0].score < 0.7;
        events = ranked.filter((result) => result.score >= ranked[0].score - 0.12).map((result) => result.obj);
    }
    const candidates = events.flatMap((event) => {
        const rows = owned.filter((row) => row.matchId === event._id &&
            (!selection.bookingCode || row.code.toUpperCase() === selection.bookingCode.toUpperCase()));
        const active = rows.filter((row) => row.status === "booked");
        return (active.length ? active : rows.filter((row) => row.status === "cancelled"))
            .map((row) => ({ bookingId: row._id, bookingCode: row.code, matchId: event._id,
                title: event.title, quantity: row.quantity, status: row.status }));
    });
    if (candidates.length !== 1 || uncertainEvent)
        return { status: candidates.length ? "ambiguous" : "not_found", candidates,
            eventSearch: selection.eventSearch };
    const target = candidates[0];
    const booking = owned.find((row) => row._id === target.bookingId);
    const match = events.find((event) => event._id === target.matchId);
    const now = new Date(state.now);
    const startsAt = new Date(match.startsAt);
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(startsAt.getTime()) ||
        !(match.refundFullHoursBefore === null ||
            Number.isFinite(match.refundFullHoursBefore) && match.refundFullHoursBefore >= 0))
        throw new Error("Refund calculation requires valid site time and policy.");
    return { ...target, status: booking.status === "booked" ? "ready" : "already_cancelled",
        eventSearch: selection.eventSearch, explicitBookingCode: Boolean(selection.bookingCode),
        siteTime: state.now, currency: "INR", totalPaid: booking.totalPrice,
        refund: getRefundAmount({ ...match, startsAt }, booking, now), policy: match.policyText };
}

export function checkExistingCancellation(state, task, bookingCode, account, resolution) {
    const checks = [];
    const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
    const bookings = state.bookings.filter((row) => row.code === bookingCode && row.userId === account.userId);
    const booking = bookings[0];
    const match = state.matches.find((row) => row._id === booking?.matchId);
    const receipt = state.outbox.find((row) => row.relatedBookingId === booking?._id &&
        row.type === "cancellation" && row.to === account.email &&
        row.body.includes(`Refund INR ${booking?.refundAmount}`));
    const now = new Date(state.now).getTime();
    const cancelledAt = new Date(booking?.cancelledAt ?? "").getTime();
    const start = new Date(match?.startsAt ?? "").getTime();
    const hours = match?.refundFullHoursBefore;
    const validPolicy = hours === null || (Number.isFinite(hours) && hours >= 0);
    const refundAt = (time) => hours !== null && time <= start - hours * 3600000
        ? booking?.totalPrice : 0;

    const requestedCodes = task.match(/\bMD-[A-Z0-9]+\b/gi) ?? [];
    const explicit = requestedCodes.length === 1 && requestedCodes[0].toUpperCase() === bookingCode.toUpperCase();
    if (!resolution && explicit)
        resolution = cancellationDetails(state, { bookingCode }, account);
    check("explicit cancellation intent and resolved target", /\bcancel\b/i.test(task) &&
        requestedCodes.length <= 1 && (!requestedCodes.length || explicit) &&
        resolution?.status === "already_cancelled" && resolution.bookingCode === bookingCode);
    check("resolved event and booking IDs match", match && resolution?.bookingId === booking?._id &&
        resolution?.matchId === match._id);
    check("one owned booking already cancelled", bookings.length === 1 && booking?.status === "cancelled");
    check("valid site time, cancellation time and policy", Number.isFinite(now) &&
        Number.isFinite(cancelledAt) && cancelledAt <= now && Number.isFinite(start) && validPolicy);
    check("recorded refund matches cancellation-time policy", Number.isFinite(booking?.totalPrice) &&
        booking.totalPrice >= 0 && booking?.refundAmount === refundAt(cancelledAt));
    check("existing cancellation receipt confirms refund", receipt);

    const success = checks.every((entry) => entry.passed);
    return {
        success,
        checks,
        actions: [],
        outcome: "already_satisfied",
        records: booking ? [booking] : [],
        outbox: receipt ? [receipt] : [],
        siteTime: state.now,
        ...(success ? {
            currentPolicyRefund: refundAt(now),
            summary: `Booking ${booking.code} for ${match.title} was already cancelled. Recorded refund INR ${booking.refundAmount}, confirmed by its existing cancellation receipt. At site time ${state.now}, the policy would allow INR ${refundAt(now)} for an active booking. No new cancellation or refund was submitted.`,
        } : {}),
    };
}
