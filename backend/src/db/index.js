import mongoose from 'mongoose'
import { DB_NAME } from '../constants.js'
import "../config.js";


const connectDB=async()=>{
    try {
        await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`);
        return mongoose.connection;
    } catch {
        throw new Error("MongoDB connection failed");
    }
}

export default connectDB
