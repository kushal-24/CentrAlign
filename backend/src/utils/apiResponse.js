class apiResponse {
    constructor(
        data,
        statusCode,
        message = "All isss welll"
    ) 
    {
        this.statusCode = statusCode,
        this.data = data,
        this.message = message,
        this.success = statusCode < 400
    }
}

export default apiResponse;