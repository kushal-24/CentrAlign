import { Router } from "express";
import { showProfile, updateProfile } from "../../../controllers/profile.controller.js";
import { requireUser } from "../../middleware/page-context.js";
import { mutationOrigin } from "../../middleware/mutation-origin.js";

const router = Router();
router.use(requireUser);
router.route("/").get(showProfile).post(mutationOrigin, updateProfile);
export default router;
