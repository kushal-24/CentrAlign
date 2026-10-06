import { Router } from "express";
import { listMatches, showMatch } from "../../../controllers/matches.controller.js";

const router = Router();

router.get("/", listMatches);
router.get("/:id", showMatch);

export default router;
