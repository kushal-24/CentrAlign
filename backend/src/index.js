import dotenv from "dotenv";
import connectDB from './db/index.js';
dotenv.config();
import { app } from './app.js';


connectDB()
.then(()=>{
    app.listen(port, ()=>{
        console.log(`🚀 Server running at http://localhost:${port}`);
    })
})
.catch((err)=>{
    console.log(`connection to DB failed : error is :- ${err}`);
    
})

app.get('/',(req,res)=>{
    res.send('server is Live!');
})

const port=process.env.PORT||3000;

