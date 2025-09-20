import 'dotenv/config';
import express from 'express';
import cors from 'cors';
// import { initializeSentry, sentryErrorHandler } from './config/sentry.js'; // Sentry would be configured here
import { bot, setupWebhook } from './config/botClient.js';
import { initializeCommandHandlers } from './handlers/commandHandler.js';
import { initializeCallbackHandlers } from './handlers/callbackHandler.js';

// --- Environment Variable Validation ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 8080;
const isProduction = process.env.NODE_ENV === 'production';

// --- App Initialization ---
const app = express();
const webhookPath = `/api/webhook/${TOKEN}`;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Health Check Endpoint ---
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- Webhook Endpoint ---
app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// --- Home Route for Basic Info ---
app.get('/', (req, res) => {
    res.send('AI Parlay Virtuoso is running!');
});

// --- INITIALIZE TELEGRAM HANDLERS ---
initializeCommandHandlers();
initializeCallbackHandlers();

// --- Server Startup ---
app.listen(PORT, async () => {
    console.log(`✅ Server is live and listening on port ${PORT}`);
    if (isProduction) {
        console.log('Production environment detected. Setting webhook...');
        await setupWebhook();
    } else {
        console.log('Development mode: Using polling.');
    }
});
