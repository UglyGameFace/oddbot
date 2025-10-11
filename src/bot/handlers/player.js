// src/bot/handlers/player.js

import oddsService from '../../services/oddsService.js';
import gamesService from '../../services/gamesService.js';
import { setUserState, getUserState, saveToken, loadToken } from '../state.js';
import { formatGameTimeTZ } from '../../utils/botUtils.js';
import { getSportEmoji } from '../../services/sportsService.js';

// --- Command to Start the Player Search Flow ---
export function registerPlayer(bot) {
  bot.onText(/^\/player$/, async (msg) => {
    const chatId = msg.chat.id;
    await setUserState(chatId, { waitingForPlayerName: true }, 120); // State expires in 2 minutes
    await bot.sendMessage(chatId, '🔍 *Find Player Props*\n\nEnter the full or partial last name of the player you want to find:', { parse_mode: 'Markdown' });
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = await getUserState(chatId);

    if (state.waitingForPlayerName && msg.text && !msg.text.startsWith('/')) {
      const playerNameQuery = msg.text.trim().toLowerCase();
      await setUserState(chatId, {}); // Clear state

      await bot.sendMessage(chatId, `Searching for players matching "*${playerNameQuery}*"...`, { parse_mode: 'Markdown' });
      
      try {
        const uniquePlayers = await findUniquePlayers(playerNameQuery);

        if (Object.keys(uniquePlayers).length === 0) {
          return bot.sendMessage(chatId, `No players found matching "${playerNameQuery}".`);
        }

        if (Object.keys(uniquePlayers).length === 1) {
          const singlePlayerKey = Object.keys(uniquePlayers)[0];
          const playerData = uniquePlayers[singlePlayerKey];
          return displayPlayerProps(bot, chatId, playerData);
        }

        // If multiple players are found, present a selection menu
        const text = `Multiple players found. Please select the correct one:`;
        const keyboard = await Promise.all(Object.entries(uniquePlayers).map(async ([key, data]) => {
            const token = await saveToken('player_select', { key, data });
            return [{ text: `${data.name} (${data.sport.toUpperCase()})`, callback_data: `player_select_${token}` }];
        }));
        
        await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });

      } catch (error) {
        console.error("Player search error:", error);
        await bot.sendMessage(chatId, 'An error occurred while searching for players.');
      }
    }
  });
}

// --- Callback Handler for Player Selection ---
export function registerPlayerCallbacks(bot) {
  bot.on('callback_query', async (cbq) => {
    const { data, message } = cbq || {};
    if (!data || !message || !data.startsWith('player_')) return;

    const chatId = message.chat.id;
    await bot.answerCallbackQuery(cbq.id);

    const parts = data.split('_');
    const action = parts[1];

    if (action === 'select') {
        const token = parts.slice(2).join('_');
        const payload = await loadToken('player_select', token);
        if (payload && payload.data) {
            await bot.deleteMessage(chatId, message.message_id);
            await displayPlayerProps(bot, chatId, payload.data);
        }
    }
  });
}

// --- Helper Functions ---

async function findUniquePlayers(query) {
    const availableSports = await gamesService.getAvailableSports();
    if (!availableSports.length) return {};

    const uniquePlayers = {};

    await Promise.all(availableSports.map(async (sport) => {
        const games = await gamesService.getGamesForSport(sport.sport_key);
        if (!games) return;

        await Promise.all(games.map(async (game) => {
            const bookmakers = await oddsService.getPlayerPropsForGame(sport.sport_key, game.id);
            if (!bookmakers || !bookmakers.length) return;

            bookmakers.forEach(bookmaker => {
                bookmaker.markets.forEach(market => {
                    market.outcomes.forEach(outcome => {
                        const playerName = outcome.description;
                        if (playerName && playerName.toLowerCase().includes(query)) {
                            const playerKey = `${playerName}-${sport.sport_key}`;
                            if (!uniquePlayers[playerKey]) {
                                uniquePlayers[playerKey] = {
                                    name: playerName,
                                    sport: sport.sport_key,
                                    props: []
                                };
                            }
                            uniquePlayers[playerKey].props.push({
                                game: `${game.away_team} @ ${game.home_team}`,
                                commence_time: game.commence_time,
                                market: market.key,
                                pick: `${outcome.name} ${outcome.point || ''}`.trim(),
                                price: outcome.price,
                                bookmaker: bookmaker.title,
                            });
                        }
                    });
                });
            });
        }));
    }));
    return uniquePlayers;
}

async function displayPlayerProps(bot, chatId, playerData) {
    let response = `*Found ${playerData.props.length} prop(s) for ${playerData.name}:*\n\n`;
    
    // Group props by game
    const propsByGame = playerData.props.reduce((acc, prop) => {
        if (!acc[prop.game]) {
            acc[prop.game] = { commence_time: prop.commence_time, props: [] };
        }
        acc[prop.game].props.push(prop);
        return acc;
    }, {});

    Object.entries(propsByGame).forEach(([game, data]) => {
        response += `*${game}*\n`;
        response += `${getSportEmoji(playerData.sport)} ${formatGameTimeTZ(data.commence_time)}\n`;
        data.props.forEach(prop => {
            response += `  • *${prop.market}:* **${prop.pick}** (${prop.price > 0 ? '+' : ''}${prop.price}) - *${prop.bookmaker}*\n`;
        });
        response += `\n`;
    });

    await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
}
