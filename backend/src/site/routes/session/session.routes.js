import { Router } from "express";
import { openDemoSession, closeDemoSession } from "../../../controllers/session.controller.js";
import { mutationOrigin } from "../../middleware/mutation-origin.js";

const router = Router();
router.post("/demo", mutationOrigin, openDemoSession);
router.post("/close", mutationOrigin, closeDemoSession);
export default router;
