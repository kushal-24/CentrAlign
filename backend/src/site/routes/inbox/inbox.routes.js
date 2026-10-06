import { Router } from "express";
import { listInbox } from "../../../controllers/inbox.controller.js";
import { requireUser } from "../../middleware/page-context.js";
const router = Router();
router.use(requireUser);
router.get("/", listInbox);
export default router;
