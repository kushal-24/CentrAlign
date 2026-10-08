import { Router } from "express";
import { createTaskControllers } from "../../controllers/tasks.controller.js";

export function createTaskRouter(runtime) {
    const router = Router();
    const { createTask, getTask, getTaskTrace, answerTask, approveTask, rejectTask } =
        createTaskControllers(runtime);

    router.post("/", createTask);
    router.get("/:id", getTask);
    router.get("/:id/trace", getTaskTrace);
    router.post("/:id/answer", answerTask);
    router.post("/:id/approve", approveTask);
    router.post("/:id/reject", rejectTask);
    return router;
}
