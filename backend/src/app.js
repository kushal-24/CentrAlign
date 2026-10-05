import express from "express"
import cookieParser from "cookie-parser"
import cors from "cors"
import passport from "passport"



const app=express();

app.use(cors({
    origin: process.env.CORS_ORIGIN, //👉 “Allow this frontend to access my backend and allow cookies.”
    credentials: true,
}))

// app.use("/auth",googleAuthRoutes)
app.use(passport.initialize());
app.use(express.json({limit: "16kb"}));
app.use(express.urlencoded({extended: true, limit:"16kb"}));
app.use(express.static("public"))
app.use(cookieParser());


// app.use('/api/v1/user/', userRouter);

export {app}