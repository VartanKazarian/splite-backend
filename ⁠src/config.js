require('dotenv').config();

module.exports = {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development',
    jwtSecret: process.env.JWT_SECRET || 'dev_jwt_secret',
    webhookSecret: process.env.WEBHOOK_SECRET || 'dev_webhook_secret',
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER || 'sobremesa',
        password: process.env.DB_PASSWORD || 'sobremesa_pass',
        database: process.env.DB_NAME || 'sobremesa_db',
    },
    exchangeRateApiUrl: process.env.EXCHANGE_RATE_API_URL
};
