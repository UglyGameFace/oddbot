import { bot } from '../config/botClient.js';
import { findOrCreateUser } from '../services/userService.js';

const disclaimer = "Disclaimer: For entertainment and informational purposes only. This is not a gambling service, and no real money is handled. All information is provided as-is with no guarantee of accuracy or financial gain.";

const ageGateKeyboard = {
    inline_keyboard: [
        [
            { text: "✅ Yes, I am", callback_data: "age_gate_yes" },
            { text: "❌ No, I am not", callback_data: "age_gate_no" }
        ]
    ]
};

const handleStartCommand = async (msg) => {
    const chatId = msg.chat.id;
    const userInfo = {
        id: msg.from.id,
        first_name: msg.from.first_name,
        username: msg.from.username,
    };

    try {
        // The user record is created here, but they can't use the bot yet.
        await findOrCreateUser(userInfo);
        
        const welcomeText = `Welcome to the AI Parlay Virtuoso!\n\nThis bot contains sports betting information. Are you of legal age to view this content in your jurisdiction?\n\n---\n\n${disclaimer}`;
        
        bot.sendMessage(chatId, welcomeText, {
            reply_markup: ageGateKeyboard
        });

    } catch (error) {
        console.error("Error handling /start command:", error);
        bot.sendMessage(chatId, "Sorry, there was an error starting the bot. Please try again later.");
    }
};

export const initializeCommandHandlers = () => {
    bot.onText(/\/start/, handleStartCommand);
    // Future commands like /bankroll, /lines, etc., will be registered here.
    console.log("Command handlers initialized.");
};
