import { Router } from "express";
import { listMatches, showMatch } from "../../../controllers/matches.controller.js";

import { showBookingForm, createBooking } from "../../../controllers/bookings.controller.js";
import { showWaitlistForm, joinWaitlist } from "../../../controllers/waitlist.controller.js";
import { requireUser } from "../../middleware/page-context.js";
import { mutationOrigin } from "../../middleware/mutation-origin.js";

const router = Router();

router.get("/", listMatches);
router.get("/:id", showMatch);
router
    .route("/:id/book")
    .get(requireUser, showBookingForm)
    .post(requireUser, mutationOrigin, createBooking);
router
    .route("/:id/waitlist")
    .get(requireUser, showWaitlistForm)
    .post(requireUser, mutationOrigin, joinWaitlist);

export default router;
