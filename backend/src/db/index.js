import mongoose from 'mongoose'
import { DB_NAME } from '../constants.js'
import dotenv from "dotenv";
dotenv.config(); // NO PATH, let it auto-detect .env in project root


const connectDB=async()=>{
    try {
        await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`);
        console.log(`hogaya bhaii connect database`)
    } catch (err) {
        console.log(`connection has failed`);
        console.log("URI:", process.env.MONGODB_URI);
        console.log("xonnectione rror:", err);
        process.exit();
    }
}

export default connectDB