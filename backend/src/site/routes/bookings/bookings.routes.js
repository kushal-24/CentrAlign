import { Router } from "express";
import { listBookings, showBooking } from "../../../controllers/bookings.controller.js";
import { requireUser } from "../../middleware/page-context.js";
const router = Router();
router.use(requireUser);
router.get("/", listBookings);
router.get("/:id", showBooking);
export default router;
