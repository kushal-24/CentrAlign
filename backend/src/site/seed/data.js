import mongoose from "mongoose";

export const SEED_NOW = "2026-10-10T14:00:00+05:30";
const seedTime = Date.parse(SEED_NOW);
const hour = 60 * 60 * 1000;
const day = 24 * hour;
export const seedId = (prefix, number) =>
    new mongoose.Types.ObjectId(`${prefix}${number.toString(16).padStart(22, "0")}`);
const at = (offset) => new Date(seedTime + offset);
// Bonus features to be looked on later: ticket tiers.
// const general = (capacity = 40, sold = 0, price = 500) => ({
//     name: "General",
//     price,
//     capacity,
//     sold,
// });
// const premium = (capacity = 10, sold = 0, price = 1500) => ({
//     name: "Premium",
//     price,
//     capacity,
//     sold,
// });
//
const tickets = (capacity = 40, sold = 0, price = 500) => ({ capacity, sold, price });

export function buildSeedData(studentEmail) {
    const users = [
        { name: "Demo Student", email: studentEmail },
        { name: "Riya Shah", email: "riya@example.com" },
        { name: "Aman Rao", email: "aman@example.com" },
        { name: "Sam Lee", email: "sam@example.com" },
        { name: "Nora Patel", email: "nora@example.com" },
        { name: "Alex Tan", email: "alex@example.com" },
    ].map((user, index) => ({
        ...user,
        _id: seedId("10", index + 1),
        phone: `+91900000000${index + 1}`,
    }));

    const definitions = [
        [
            "cricket",
            "India vs Australia — T20",
            "Festival T20",
            "India vs Australia",
            "Garden Cricket Ground",
            "Bengaluru",
            "India",
            -hour,
            2 * hour,
            "Asia/Kolkata",
            "IST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(), premium()],
            tickets(),
        ],
        [
            "football",
            "Northbridge FC vs Harbor United",
            "Atlantic Cup",
            "Northbridge FC vs Harbor United",
            "Riverside Stadium",
            "Lisbon",
            "Portugal",
            -hour / 2,
            1.5 * hour,
            "Europe/Lisbon",
            "WEST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(), premium()],
            tickets(),
        ],
        [
            "cricket",
            "India vs Australia — ODI",
            "Autumn ODI Series",
            "India vs Australia",
            "City Cricket Oval",
            "Bangalore",
            "India",
            2 * day,
            2 * day + 8 * hour,
            "Asia/Kolkata",
            "IST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(20, 18, 800), premium(10, 0, 2000)],
            tickets(20, 18, 800),
        ],
        [
            "cricket",
            "India Women vs Australia Women",
            "Women's Autumn ODI Series",
            "India Women vs Australia Women",
            "Coastal Cricket Ground",
            "Mumbai",
            "India",
            3 * day,
            3 * day + 8 * hour,
            "Asia/Kolkata",
            "IST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(40, 0, 400), premium()],
            tickets(40, 0, 400),
        ],
        [
            "tennis",
            "London tennis semi-final",
            "Thames Invitational",
            "Maya Ellis vs Hana Mori",
            "Thames Tennis Centre",
            "London",
            "United Kingdom",
            day,
            day + 3 * hour,
            "Europe/London",
            "BST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(10, 10, 700), premium(10, 2, 2000)],
            tickets(20, 12, 700),
        ],
        [
            "tennis",
            "Madrid tennis quarter-final",
            "Sunrise Masters",
            "Luca Santos vs Theo Blake",
            "Sunrise Tennis Arena",
            "Madrid",
            "Spain",
            5 * day,
            5 * day + 3 * hour,
            "Europe/Madrid",
            "CEST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(30, 0, 6000), premium(10, 0, 12000)],
            tickets(30, 0, 6000),
        ],
        [
            "badminton",
            "Hyderabad badminton final",
            "Deccan Shuttle Cup",
            "Arjun Sen vs Ken Ito",
            "Deccan Indoor Arena",
            "Hyderabad",
            "India",
            2 * day,
            2 * day + 2 * hour,
            "Asia/Kolkata",
            "IST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(12, 12, 300), premium(5, 5, 900)],
            tickets(17, 17, 300),
        ],
        [
            "badminton",
            "Jakarta badminton doubles",
            "Island Doubles Open",
            "Team Lotus vs Team Coral",
            "Island Sports Hall",
            "Jakarta",
            "Indonesia",
            4 * day,
            4 * day + 2 * hour,
            "Asia/Jakarta",
            "WIB",
            // Bonus features to be looked on later: ticket tiers.
            // [general(30, 0, 250), premium()],
            tickets(30, 0, 250),
        ],
        [
            "football",
            "Rovers vs Eastgate",
            "Eastern Football Cup",
            "Rovers vs Eastgate",
            "Eastern Stadium",
            "Kolkata",
            "India",
            3 * day + 5 * hour,
            3 * day + 7 * hour,
            "Asia/Kolkata",
            "IST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(50, 2, 500), premium()],
            tickets(50, 2, 500),
        ],
        // Tokyo uses a different wall time so its absolute interval overlaps Kolkata.
        [
            "football",
            "Cityside vs Westfield",
            "Pacific Football Cup",
            "Cityside vs Westfield",
            "Pacific Stadium",
            "Tokyo",
            "Japan",
            3 * day + 4.5 * hour,
            3 * day + 6.5 * hour,
            "Asia/Tokyo",
            "JST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(40, 0, 650), premium()],
            tickets(40, 0, 650),
        ],
        [
            "football",
            "Pune fan-arena screening",
            "Community Fan Festival",
            "Northbridge FC vs Rovers screening",
            "Community Fan Arena",
            "Pune",
            "India",
            6 * day,
            6 * day + 3 * hour,
            "Asia/Kolkata",
            "IST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(100, 0, 0)],
            tickets(100, 0, 0),
        ],
        [
            "badminton",
            "Kuala Lumpur badminton open",
            "City Shuttle Open",
            "Mei Lin vs Zara Khan",
            "Central Shuttle Hall",
            "Kuala Lumpur",
            "Malaysia",
            2 * day,
            2 * day + 2 * hour,
            "Asia/Kuala_Lumpur",
            "MYT",
            // Bonus features to be looked on later: ticket tiers.
            // [general(), premium()],
            tickets(),
        ],
        [
            "tennis",
            "Mumbai evening tennis",
            "Coastal Tennis Cup",
            "Riya Desai vs Aiko Sato",
            "Coastal Tennis Arena",
            "Mumbai",
            "India",
            4 * hour,
            7 * hour,
            "Asia/Kolkata",
            "IST",
            // Bonus features to be looked on later: ticket tiers.
            // [general(20, 1, 700), premium()],
            tickets(20, 1, 700),
        ],
        [
            "cricket",
            "Coastal cricket exhibition",
            "Coastal Friendly Series",
            "Bay XI vs Hill XI",
            "Bay Cricket Ground",
            "Chennai",
            "India",
            -day,
            -day + 8 * hour,
            "Asia/Kolkata",
            "IST",
            // Bonus features to be looked on later: ticket tiers.
            // [general()],
            tickets(),
        ],
        [
            "tennis",
            "Melbourne tennis final",
            "Southern Invitational",
            "Leo Park vs Emil Reed",
            "Southern Tennis Centre",
            "Melbourne",
            "Australia",
            -2 * day,
            -2 * day + 3 * hour,
            "Australia/Melbourne",
            "AEDT",
            // Bonus features to be looked on later: ticket tiers.
            // [general()],
            tickets(),
        ],
        [
            "badminton",
            "Singapore shuttle semi-final",
            "Harbor Shuttle Cup",
            "Tara Lim vs Sora Kim",
            "Harbor Sports Hall",
            "Singapore",
            "Singapore",
            -3 * day,
            -3 * day + 2 * hour,
            "Asia/Singapore",
            "SGT",
            // Bonus features to be looked on later: ticket tiers.
            // [general()],
            tickets(),
        ],
        [
            "football",
            "Hillcrest vs Rivergate",
            "Highland Football Cup",
            "Hillcrest vs Rivergate",
            "Highland Stadium",
            "Edinburgh",
            "United Kingdom",
            -4 * day,
            -4 * day + 2 * hour,
            "Europe/London",
            "BST",
            // Bonus features to be looked on later: ticket tiers.
            // [general()],
            tickets(),
        ],
        [
            "cricket",
            "Desert cricket friendly",
            "Desert Exhibition Series",
            "Dune XI vs Oasis XI",
            "Desert Cricket Ground",
            "Dubai",
            "United Arab Emirates",
            -5 * day,
            -5 * day + 8 * hour,
            "Asia/Dubai",
            "GST (UTC+04:00)",
            // Bonus features to be looked on later: ticket tiers.
            // [general()],
            tickets(),
        ],
    ];
    const policies = [
        "Full refund until one day before the first ball; later cancellations receive nothing.",
        "Cancel at least 24 hours before kick-off for a complete refund. After that, no refund.",
        "Your payment is fully refundable up to 24 hours before play begins; otherwise the refund is zero.",
        "A day's notice earns a full refund. Less than 24 hours before play: no money returned.",
        "Refunds of the entire ticket price are available until 24 hours before the session starts.",
        "These tickets are non-refundable. Cancellation returns no payment.",
        "A full refund applies when cancellation is 48 hours or more before the final; later refunds are zero.",
        "Give us 24 hours before the doubles session for a full refund; late cancellations are not refunded.",
        "Full refund if cancelled 24 hours or more before kick-off; no refund after.",
        "Cancel one day or earlier before the match to recover your full payment; no refund inside that window.",
        "This is a free screening. Your RSVP costs nothing and no money needs to be refunded.",
        "The match is postponed and bookings are on hold. Cancellation policy: full refund with 24 hours' notice.",
        "No refund inside 24 hours of the session. Before that cutoff, the whole ticket price is returned.",
    ];
    const matches = definitions.map(
        (
            [
                sport,
                title,
                competition,
                participants,
                venue,
                city,
                country,
                start,
                end,
                zone,
                label,
                inventory,
            ],
            index,
        ) => {
            const startsAt = at(start);
            const displayTime = `${new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(startsAt)} ${label}`;
            return {
                _id: seedId("20", index + 1),
                sport,
                title,
                competition,
                participants,
                venue,
                city,
                country,
                startsAt,
                endsAt: at(end),
                displayTime,
                ...inventory,
                perBookingLimit: index === 7 ? 2 : 4,
                isFree: index === 10,
                bookingStatus: index === 11 ? "postponed" : "open",
                policyText:
                    policies[index] ||
                    "Exhibition tickets allow full refunds at least 24 hours before play; none afterwards.",
                refundFullHoursBefore: index === 5 ? null : index === 6 ? 48 : 24,
            };
        },
    );

    const bookings = [];
    const addBooking = (matchNumber, userNumber, quantity, createdAt = at(-day)) => {
        const match = matches[matchNumber - 1];
        const user = users[userNumber - 1];
        const index = bookings.length + 1;
        bookings.push({
            _id: seedId("30", index),
            code: `MD-${1000 + index}`,
            matchId: match._id,
            userId: user._id,
            ownerName: user.name,
            ownerEmail: user.email,
            // Bonus features to be looked on later: ticket tiers.
            // tier: tierName,
            quantity,
            // Bonus features to be looked on later: ticket tiers.
            // totalPrice: match.tiers.find((tier) => tier.name === tierName).price * quantity,
            totalPrice: match.price * quantity,
            status: "booked",
            refundAmount: 0,
            createdAt,
            cancelledAt: null,
        });
    };
    addBooking(9, 1, 2);
    addBooking(13, 1, 1, at(-hour));
    [4, 4, 4, 4, 2].forEach((quantity, index) => addBooking(3, index + 2, quantity));
    [4, 4, 2].forEach((quantity, index) => addBooking(5, index + 2, quantity));
    addBooking(5, 5, 2);
    [4, 4, 4].forEach((quantity, index) => addBooking(7, index + 2, quantity));
    addBooking(7, 5, 3);
    addBooking(7, 6, 2);

    const outbox = bookings.map((booking, index) => ({
        _id: seedId("40", index + 1),
        to: booking.ownerEmail,
        subject: `Booking confirmed: ${booking.code}`,
        body: `${booking.code}: ${booking.quantity} ticket(s) for ${matches.find((match) => match._id.equals(booking.matchId)).title}. Total INR ${booking.totalPrice}.`,
        type: "booking_confirmation",
        relatedBookingId: booking._id,
        createdAt: booking.createdAt,
    }));
    return {
        users,
        matches,
        bookings,
        waitlist: [],
        outbox,
        config: [{ _id: seedId("50", 1), key: "mockNow", value: SEED_NOW }],
    };
}
