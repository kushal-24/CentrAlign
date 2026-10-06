import { Router } from "express";
import { localhostOnly, readClock, updateClock } from "../../../controllers/clock.controller.js";

const router = new Router();
router.use(localhostOnly);
router.route("/").get(readClock).post(updateClock);

export default router;
