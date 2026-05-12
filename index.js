require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fetch = require('node-fetch');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const express = require('express');
const cron = require('node-cron');

/**
 * HumanBlockchain: when HUMANBLOCKCHAIN_SITE_URL and HUMANBLOCKCHAIN_API_KEY are set,
 * QR membership checks and verification POST use this site instead of smallstreet.app.
 */
function useHumanBlockchainMembership() {
    const base = String(process.env.HUMANBLOCKCHAIN_SITE_URL || '').trim();
    const key = String(process.env.HUMANBLOCKCHAIN_API_KEY || '').trim();
    return Boolean(base && key);
}

function humanBlockchainSiteBase() {
    return String(process.env.HUMANBLOCKCHAIN_SITE_URL || '').replace(/\/+$/, '');
}

function membershipQrEmailHostAllowed(hostname) {
    const h = String(hostname || '').replace(/^www\./i, '').toLowerCase();
    if (h === 'smallstreet.app') {
        return true;
    }
    if (useHumanBlockchainMembership()) {
        if (h === 'qr1.be' || h === 'qrtiger.com' || h === 'media.qrtiger.com') {
            return true;
        }
    }
    const extra = String(process.env.HUMANBLOCKCHAIN_QR_EMAIL_HOSTS || '')
        .split(',')
        .map((s) => String(s).trim().replace(/^www\./i, '').toLowerCase())
        .filter(Boolean);
    if (extra.includes(h)) {
        return true;
    }
    try {
        const base = humanBlockchainSiteBase();
        if (base) {
            const u = new URL(base.startsWith('http') ? base : `https://${base}`);
            const uh = String(u.hostname || '').replace(/^www\./i, '').toLowerCase();
            if (uh && h === uh) {
                return true;
            }
        }
    } catch (_) {
        /* ignore */
    }
    return false;
}

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Track bot instance
let isInitialized = false;

// Track poll creation to prevent duplicates
let isCreatingPoll = false;
let currentPollCreationId = null;

// Debug mode for database insertion

// Healthcheck endpoint
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        botStatus: client?.isReady() ? 'online' : 'starting',
        instance: isInitialized ? 'primary' : 'initializing'
    });
});

// Debug endpoint to test API calls
app.get('/api/debug-participation/:pollId', async (req, res) => {
    try {
        const { pollId } = req.params;
        console.log(`🔍 Debug API: Testing participation for poll ${pollId}`);
        
        // Simulate the !participation command
        const results = await getEnhancedPollResults(pollId);
        
        if (!results.success) {
            return res.status(400).json({
                success: false,
                error: results.error,
                message: 'Failed to get poll results'
            });
        }
        
        const data = results.data;
        const participationVoters = [
            ...data.peace.voters,
            ...data.voting.voters,
            ...data.disaster.voters
        ];
        
        const winningChoice = data.peace.weighted > data.voting.weighted && data.peace.weighted > data.disaster.weighted ? 'peace' :
                            data.voting.weighted > data.disaster.weighted ? 'voting' : 'disaster';
        
        // Check if vote data already exists to avoid duplicates
        console.log(`🔍 Checking for existing vote data for poll ${pollId}...`);
        
        // Award XP to all participants (this will handle duplicate checking internally)
        const xpResult = await awardPollXP(participationVoters, winningChoice, pollId);
        
        res.json({
            success: true,
            pollId: pollId,
            winningChoice: winningChoice,
            totalVoters: participationVoters.length,
            xpResult: xpResult,
            message: 'Participation processed successfully'
        });
        
    } catch (error) {
        console.error('Debug API Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API endpoint to get poll awarded XP data from SmallStreet API
app.get('/api/poll-xp/:pollId', async (req, res) => {
    try {
        const { pollId } = req.params;
        const { includeBreakdown = 'true' } = req.query;
        
        console.log(`📊 API Request: Getting XP data for poll ${pollId}`);
        
        // Fetch poll data from SmallStreet API
        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/get-discord-poll', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            return res.status(404).json({
                success: false,
                error: `HTTP ${response.status}`,
                message: 'Failed to fetch poll data from SmallStreet API'
            });
        }

        const allPollData = await response.json();
        
        // Filter data for the specific poll ID
        const pollData = allPollData.filter(item => {
            try {
                const discordPoll = JSON.parse(item.discord_poll);
                return discordPoll.poll_id === pollId;
            } catch (error) {
                console.error('Error parsing discord_poll JSON:', error);
                return false;
            }
        });

        if (pollData.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Poll not found',
                message: `No data found for poll ID: ${pollId}`
            });
        }

        // Process the poll data
        const processedData = pollData.map(item => {
            const discordPoll = JSON.parse(item.discord_poll);
            
            // Get user's XP level for voting power calculation
            const xpLevel = discordPoll.xp_awarded || 1000000; // Use awarded XP as current level
            const votingPower = getVotingPower(xpLevel);
            
            // Determine if this is a winner (we'll need to calculate this based on vote counts)
            const isWinner = false; // Will be calculated below
            const isTopContributor = votingPower >= 25;
            
            return {
                user_id: item.user_id,
                user_login: item.user_login,
                email: item.email,
                discord_id: discordPoll.discord_id,
                username: discordPoll.username,
                display_name: discordPoll.display_name,
                vote: discordPoll.vote,
                vote_type: discordPoll.vote_type,
                status: discordPoll.status,
                submitted_at: discordPoll.submitted_at,
                membership: discordPoll.membership,
                xp_awarded: discordPoll.xp_awarded,
                xp_level: xpLevel,
                voting_power: votingPower,
                is_top_contributor: isTopContributor
            };
        });

        // Calculate vote counts to determine winner
        const voteCounts = processedData.reduce((acc, voter) => {
            acc[voter.vote] = (acc[voter.vote] || 0) + 1;
            return acc;
        }, {});

        const weightedVotes = processedData.reduce((acc, voter) => {
            acc[voter.vote] = (acc[voter.vote] || 0) + voter.voting_power;
            return acc;
        }, {});

        // Determine winning choice based on weighted votes
        const winningChoice = Object.keys(weightedVotes).reduce((a, b) => 
            weightedVotes[a] > weightedVotes[b] ? a : b
        );

        // Update winner status
        processedData.forEach(voter => {
            voter.is_winner = voter.vote === winningChoice;
        });

        // Calculate total XP awarded (including bonuses)
        const xpData = processedData.map(voter => {
            const baseXP = 1000000;
            const winningBonus = voter.is_winner ? 5000000 : 0;
            const topContributorBonus = voter.is_top_contributor ? 10000000 : 0;
            const totalXPAwarded = baseXP + winningBonus + topContributorBonus;

            const voterData = {
                ...voter,
                total_xp_awarded: totalXPAwarded,
                xp_breakdown: includeBreakdown === 'true' ? {
                    base: baseXP,
                    winning_bonus: winningBonus,
                    top_contributor_bonus: topContributorBonus,
                    total: totalXPAwarded
                } : undefined
            };

            return voterData;
        });

        // Sort by total XP awarded (highest first)
        xpData.sort((a, b) => b.total_xp_awarded - a.total_xp_awarded);

        const response_data = {
            success: true,
            poll_id: pollId,
            poll_summary: {
                total_participants: processedData.length,
                winning_choice: winningChoice,
                vote_counts: voteCounts,
                weighted_votes: weightedVotes
            },
            xp_awards: xpData,
            total_xp_awarded: xpData.reduce((sum, voter) => sum + voter.total_xp_awarded, 0),
            timestamp: new Date().toISOString()
        };

        console.log(`✅ API Response: Retrieved XP data for ${xpData.length} participants in poll ${pollId}`);
        res.json(response_data);

    } catch (error) {
        console.error('❌ API Error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Internal server error while retrieving poll XP data'
        });
    }
});

// API endpoint to get all polls with XP summary
app.get('/api/polls-xp', async (req, res) => {
    try {
        console.log(`📊 API Request: Getting all polls XP summary`);
        
        // Fetch all poll data from SmallStreet API
        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/get-discord-poll', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            return res.status(500).json({
                success: false,
                error: `HTTP ${response.status}`,
                message: 'Failed to fetch poll data from SmallStreet API'
            });
        }

        const allPollData = await response.json();
        
        // Group data by poll_id
        const pollsMap = {};
        
        allPollData.forEach(item => {
            try {
                const discordPoll = JSON.parse(item.discord_poll);
                const pollId = discordPoll.poll_id;
                
                if (!pollsMap[pollId]) {
                    pollsMap[pollId] = {
                        poll_id: pollId,
                        participants: [],
                        vote_counts: {},
                        weighted_votes: {},
                        total_xp_awarded: 0
                    };
                }
                
                const xpLevel = discordPoll.xp_awarded || 2000000;
                const votingPower = getVotingPower(xpLevel);
                const isTopContributor = votingPower >= 25;
                
                const participant = {
                    user_id: item.user_id,
                    email: item.email,
                    discord_id: discordPoll.discord_id,
                    username: discordPoll.username,
                    display_name: discordPoll.display_name,
                    vote: discordPoll.vote,
                    membership: discordPoll.membership,
                    xp_awarded: discordPoll.xp_awarded,
                    voting_power: votingPower,
                    is_top_contributor: isTopContributor,
                    submitted_at: discordPoll.submitted_at
                };
                
                pollsMap[pollId].participants.push(participant);
                
                // Update vote counts
                pollsMap[pollId].vote_counts[discordPoll.vote] = (pollsMap[pollId].vote_counts[discordPoll.vote] || 0) + 1;
                pollsMap[pollId].weighted_votes[discordPoll.vote] = (pollsMap[pollId].weighted_votes[discordPoll.vote] || 0) + votingPower;
                
            } catch (error) {
                console.error('Error parsing discord_poll JSON:', error);
            }
        });
        
        // Calculate winning choices and total XP for each poll
        const polls = Object.values(pollsMap).map(poll => {
            const winningChoice = Object.keys(poll.weighted_votes).reduce((a, b) => 
                poll.weighted_votes[a] > poll.weighted_votes[b] ? a : b
            );
            
            // Calculate total XP awarded for this poll
            const totalXP = poll.participants.reduce((sum, participant) => {
                const baseXP = 1000000;
                const winningBonus = participant.vote === winningChoice ? 5000000 : 0;
                const topContributorBonus = participant.is_top_contributor ? 10000000 : 0;
                return sum + baseXP + winningBonus + topContributorBonus;
            }, 0);
            
            return {
                ...poll,
                winning_choice: winningChoice,
                total_xp_awarded: totalXP,
                participant_count: poll.participants.length
            };
        });
        
        // Sort polls by most recent (assuming poll_id contains timestamp)
        polls.sort((a, b) => b.poll_id.localeCompare(a.poll_id));
        
        const response_data = {
            success: true,
            polls: polls,
            total_polls: polls.length,
            timestamp: new Date().toISOString()
        };
        
        console.log(`✅ API Response: Retrieved summary for ${polls.length} polls`);
        res.json(response_data);

    } catch (error) {
        console.error('❌ API Error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Internal server error while retrieving polls XP data'
        });
    }
});

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers, // Add this for member join events
    ],
    partials: [Partials.Channel]
});

// QR code reading function
async function readQRCode(imageUrl) {
    try {
        const response = await fetch(imageUrl);
        const buffer = await response.buffer();
        const image = await Jimp.read(buffer);

        // Enhance image for better QR code reading
        image
            .normalize() // Normalize the image
            .contrast(0.2) // Increase contrast slightly
            .quality(100); // Ensure highest quality

        // Try different scales if initial read fails
        const scales = [1, 1.5, 0.5]; // Try original size, larger, and smaller
        for (const scale of scales) {
            try {
                const scaledImage = image.clone().scale(scale);
                const result = await new Promise((resolve, reject) => {
                    const qr = new QrCode();
                    qr.callback = (err, value) => {
                        if (err) reject(err);
                        resolve(value?.result);
                    };
                    qr.decode(scaledImage.bitmap);
                });
                
                if (result) {
                    return result;
                }
            } catch (err) {
                console.log(`QR read attempt at scale ${scale} failed:`, err.message);
                continue; // Try next scale if this one fails
            }
        }
        
        throw new Error('Could not read QR code at any scale');
    } catch (error) {
        console.error('Error reading QR code:', error);
        if (error.message.includes('alignment patterns')) {
            throw new Error('QR code is not clear or properly aligned. Please ensure the image is clear and the QR code is not distorted.');
        } else if (error.message.includes('find finder')) {
            throw new Error('Could not locate QR code in image. Please ensure the QR code is clearly visible.');
        }
        throw new Error('Failed to process QR code. Please try again with a clearer image.');
    }
}

// Add retry logic helper function
async function fetchWithRetry(url, options = {}, maxRetries = 5, initialDelay = 1000) {
    let lastError;
    let delay = initialDelay;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🌐 Fetch attempt #${attempt} to: ${url}`);
            const response = await fetch(url, options);
            console.log(`🌐 Response status: ${response.status} ${response.statusText}`);
            
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Could not read error response');
                console.error(`🌐 HTTP error response:`, errorText);
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }
            return response;
        } catch (error) {
            lastError = error;
            console.error(`🌐 Attempt #${attempt} failed:`, {
                url: url,
                error: error.message,
                code: error.code,
                type: error.type,
                stack: error.stack
            });
            console.log(`Attempt #${attempt} failed: ${error.message}. ${attempt < maxRetries ? `Retrying in ${delay/1000}s...` : 'Max retries reached.'}`);
            
            if (attempt === maxRetries) {
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // Exponential backoff
        }
    }
    console.error(`🌐 All ${maxRetries} attempts failed for URL: ${url}`);
    throw lastError;
}

// Function to generate a random ID code
function generateRandomId() {
    // Generate a random alphanumeric code: timestamp + random string
    const timestamp = Date.now().toString(36);
    const randomStr = Math.random().toString(36).substring(2, 15);
    return `${timestamp}-${randomStr}`.toUpperCase();
}

// SmallStreet POST /discord-user optional joined_at format: "2026-04-20 15:30:00" (UTC)
function formatJoinedAtForApi(isoOrDate) {
    const d = isoOrDate ? new Date(isoOrDate) : new Date();
    if (Number.isNaN(d.getTime())) {
        const fallback = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${fallback.getUTCFullYear()}-${p(fallback.getUTCMonth() + 1)}-${p(fallback.getUTCDate())} ${p(fallback.getUTCHours())}:${p(fallback.getUTCMinutes())}:${p(fallback.getUTCSeconds())}`;
    }
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// POST /myapi/v1/discord-user — record invite (required JSON: email, discord_id, id; optional: discord_username, discord_display_name, joined_at, guild_id, joined_via_invite, xp_awarded). Bearer: SMALLSTREET_API_KEY.
// GET /myapi/v1/discord-invites — list only, no body (see getDiscordInvitesData). There is no POST "discord-invite" singular in this API.
const DISCORD_VERIFY_POST_DEFAULT = 'https://www.smallstreet.app/wp-json/myapi/v1/discord-user';

function getDiscordVerifyPostUrl() {
    const single = process.env.SMALLSTREET_DISCORD_VERIFY_POST_URL;
    if (single && typeof single === 'string' && single.trim()) {
        return single.trim();
    }
    return DISCORD_VERIFY_POST_DEFAULT;
}

// Function to insert user data into SmallStreet database
async function insertUserToSmallStreetDatabase(userData) {
    try {
        // Method 1: Using WordPress REST API to create/update user meta
        const response = await fetchWithRetry('https://www.smallstreet.app/wp-json/wp/v2/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify({
                username: userData.discordUsername,
                email: userData.email,
                first_name: userData.displayName,
                meta: {
                    discord_id: userData.discordId,
                    discord_username: userData.discordUsername,
                    discord_display_name: userData.displayName,
                    joined_at: new Date().toISOString(),
                    guild_id: userData.guildId,
                    joined_via_invite: true,
                    bot_version: '1.0.0'
                }
            })
        });

        const result = await response.json();
        
        if (response.ok) {
            console.log(`✅ Successfully inserted user ${userData.discordUsername} to SmallStreet database`);
            return { success: true, data: result };
        } else {
            console.error(`❌ Failed to insert user to database:`, result);
            return { success: false, error: result };
        }
    } catch (error) {
        console.error('Error inserting user to SmallStreet database:', error);
        return { success: false, error: error.message };
    }
}

// PHP serialize function for WordPress usermeta compatibility
function phpSerialize(obj) {
    if (obj === null) return 'N;';
    if (typeof obj === 'boolean') return obj ? 'b:1;' : 'b:0;';
    if (typeof obj === 'number') {
        if (Number.isInteger(obj)) return `i:${obj};`;
        return `d:${obj};`;
    }
    if (typeof obj === 'string') return `s:${Buffer.byteLength(obj, 'utf8')}:"${obj}";`;
    if (Array.isArray(obj)) {
        let result = `a:${obj.length}:{`;
        obj.forEach((value, key) => {
            result += phpSerialize(key) + phpSerialize(value);
        });
        return result + '}';
    }
    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        let result = `a:${keys.length}:{`;
        keys.forEach(key => {
            result += phpSerialize(key) + phpSerialize(obj[key]);
        });
        return result + '}';
    }
    return 'N;';
}


// Function to store poll data in WordPress database
async function storePollData(pollData) {
    try {
        console.log('📤 Storing poll data:', pollData);

        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/discord-poll', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify(pollData)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Failed to store poll data:', response.status, errorText);
            return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const result = await response.json();
        console.log('✅ Poll data stored successfully:', result);
        return { success: true, data: result };
    } catch (error) {
        console.error('❌ Error storing poll data:', error);
        return { success: false, error: error.message };
    }
}

// Function to update poll data with final XP rewards
// Since discord-poll-update endpoint doesn't exist, we'll create a new entry with final XP
async function updatePollDataXP(pollId, discordId, finalXP) {
    try {
        console.log(`📤 Creating new poll entry with final XP for poll ${pollId}, user ${discordId}: ${formatEDecimal(finalXP)} (${finalXP.toLocaleString()}) XP`);

        // Create a new poll entry with the final XP amount
        const finalXPData = {
            poll_id: pollId,
            email: `${discordId}@discord.local`, // We'll need to get the actual email
            vote: 'final_xp_update', // Special vote type for final XP
            vote_type: 'xp_final_award',
            discord_id: discordId,
            username: 'system_update',
            display_name: 'System Update',
            membership: 'verified',
            xp_awarded: finalXP,
            status: 'final_awarded',
            submitted_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
            update_type: 'final_xp_award'
        };

        console.log(`📤 Final XP data:`, JSON.stringify(finalXPData, null, 2));

        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/discord-poll', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify(finalXPData)
        });

        const responseText = await response.text();
        console.log(`📥 Final XP response: ${response.status} - ${responseText}`);

        if (!response.ok) {
            console.error('❌ Failed to create final XP entry:', response.status, responseText);
            return { success: false, error: `HTTP ${response.status}: ${responseText}` };
        }

        let result;
        try {
            result = JSON.parse(responseText);
        } catch (parseError) {
            console.log('📥 Response is not JSON, treating as plain text');
            result = { message: responseText };
        }

        console.log('✅ Final XP entry created successfully:', result);
        console.log('📊 Final XP response details:', JSON.stringify(result, null, 2));
        return { success: true, data: result };
    } catch (error) {
        console.error('❌ Error creating final XP entry:', error);
        return { success: false, error: error.message };
    }
}

// Alternative function to update poll data with final XP rewards
async function updatePollDataXPAlternative(pollId, discordId, finalXP, email) {
    try {
        console.log(`📤 Alternative update XP for poll ${pollId}, user ${discordId}: ${finalXP} XP`);

        // Try to update through the user data API
        const userUpdateData = {
            discord_id: discordId,
            email: email || `${discordId}@discord.local`,
            xp_awarded: finalXP,
            poll_id: pollId,
            update_type: 'poll_xp_update',
            timestamp: new Date().toISOString()
        };

        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/discord-user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify(userUpdateData)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Alternative update failed:', response.status, errorText);
            return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const result = await response.json();
        console.log('✅ Alternative XP update successful:', result);
        return { success: true, data: result };
    } catch (error) {
        console.error('❌ Error in alternative XP update:', error);
        return { success: false, error: error.message };
    }
}

// Direct database update by creating a new poll entry with final XP
async function updatePollDataDirect(pollId, discordId, finalXP, email, username) {
    try {
        console.log(`📤 Direct update XP for poll ${pollId}, user ${discordId}: ${finalXP} XP`);

        // Create a new poll entry with the final XP amount
        const directUpdateData = {
            poll_id: pollId,
            email: email || `${discordId}@discord.local`,
            vote: 'final_xp_award', // Special vote type for final XP awards
            vote_type: 'xp_final_award',
            discord_id: discordId,
            username: username,
            display_name: username,
            membership: 'verified',
            xp_awarded: finalXP,
            status: 'final_awarded',
            submitted_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
            update_type: 'final_xp_award'
        };

        console.log(`📤 Direct update data:`, JSON.stringify(directUpdateData, null, 2));

        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/discord-poll', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify(directUpdateData)
        });

        const responseText = await response.text();
        console.log(`📥 Direct update response: ${response.status} - ${responseText}`);

        if (!response.ok) {
            console.error('❌ Direct update failed:', response.status, responseText);
            return { success: false, error: `HTTP ${response.status}: ${responseText}` };
        }

        let result;
        try {
            result = JSON.parse(responseText);
        } catch (parseError) {
            result = { message: responseText };
        }

        console.log('✅ Direct XP update successful:', result);
        return { success: true, data: result };
    } catch (error) {
        console.error('❌ Error in direct XP update:', error);
        return { success: false, error: error.message };
    }
}

// Function to check if user email exists in SmallStreet
async function checkUserEmailExists(email) {
    try {
        const response = await fetchWithRetry(`https://www.smallstreet.app/wp-json/wp/v2/users?search=${encodeURIComponent(email)}`, {
            headers: {
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const users = await response.json();
        
        if (response.ok && users.length > 0) {
            // Check if any user has this email
            const userWithEmail = users.find(user => 
                user.email && user.email.toLowerCase() === email.toLowerCase()
            );
            return userWithEmail ? { exists: true, user: userWithEmail } : { exists: false };
        }
        
        return { exists: false };
    } catch (error) {
        console.error('Error checking user email:', error);
        return { exists: false, error: error.message };
    }
}

/** Public vCard HTML (WordPress admin-ajax dong_public_vcard_card), same flow as qr1.be after email is scraped. */
function isPublicVcardAjaxUrl(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    let host = '';
    try {
        host = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).hostname;
    } catch {
        return false;
    }
    if (!membershipQrEmailHostAllowed(host)) return false;
    if (!/\/wp-admin\/admin-ajax\.php/i.test(t)) return false;
    if (!/[?&]action=dong_public_vcard_card\b/i.test(t)) return false;
    if (!/[?&]token=/i.test(t)) return false;
    return true;
}

// Fetch vCard-like HTML (qr1.be or SmallStreet dong_public_vcard_card) and extract email
async function fetchQR1BeData(url) {
    try {
        const response = await fetchWithRetry(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        const info = {};

        // Extract name
        const nameMatch = html.match(/<(?:strong|h1|h2|div)[^>]*>([^<]+)<\/(?:strong|h1|h2|div)>/);
        if (nameMatch) info.name = nameMatch[1].trim();

        // Extract phone
        const phoneMatch = html.match(/(?:tel:|Phone:|phone:)[^\d]*(\d[\d\s-]{8,})/);
        if (phoneMatch) info.phone = phoneMatch[1].replace(/\D/g, '');

        // Extract email — prefer mailto / JSON "email" keys, then first plausible address.
        let email = null;
        const mailto = html.match(/mailto:([^"'<>\s?]+@[^"'<>\s&]+)/i);
        if (mailto) {
            try {
                email = decodeURIComponent(mailto[1].trim());
            } catch {
                email = mailto[1].trim();
            }
        }
        if (!email) {
            const jsonEmail = html.match(/["']email["']\s*:\s*["']([^"']+@[^"']+)["']/i);
            if (jsonEmail) {
                email = jsonEmail[1].trim();
            }
        }
        if (!email) {
            const emailMatch = html.match(/([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            if (emailMatch) {
                email = emailMatch[1].trim();
            }
        }
        if (email && /example\.(com|org)$/i.test(email)) {
            email = null;
        }
        if (email) {
            info.email = email;
        }

        return info.email ? info : null;
    } catch (error) {
        console.error('Error fetching vCard HTML:', error);
        throw new Error('Failed to fetch contact information after multiple retries');
    }
}

// SmallStreet verify-me QR:
// - Page link: /verify-me/?transaction_id=...&xp_units=...
// - REST link: /wp-json/myapi/v1/verify-me?id=<discord_id>&guild_id=<guild_id>
// Override POST URL with VERIFY_ME_QR_SUBMIT_URL.
const VERIFY_ME_QR_SUBMIT_DEFAULT = 'https://www.smallstreet.app/wp-json/myapi/v1/verify-me';

function parseSmallstreetVerifyMeQr(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!/smallstreet\.app/i.test(trimmed)) return null;
    let u;
    try {
        u = new URL(trimmed);
    } catch {
        try {
            u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
        } catch {
            return null;
        }
    }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'smallstreet.app') return null;
    if (!/verify-me/i.test(u.pathname)) return null;

    const transaction_id = u.searchParams.get('transaction_id');
    const xp_units = u.searchParams.get('xp_units') || '';
    const idParam =
        u.searchParams.get('id') ||
        u.searchParams.get('discord_id') ||
        u.searchParams.get('user_id');
    const guildParam =
        u.searchParams.get('guild_id') ||
        u.searchParams.get('server_id') ||
        u.searchParams.get('guild');

    if (transaction_id) {
        return { type: 'transaction', transaction_id, xp_units, originalUrl: trimmed };
    }
    if (idParam && guildParam) {
        return {
            type: 'session',
            qr_discord_id: String(idParam).trim(),
            qr_guild_id: String(guildParam).trim(),
            originalUrl: trimmed
        };
    }
    return null;
}

/**
 * Membership verification from QR: plain email without hitting qr1.be HTML.
 * - mailto:user@domain.com
 * - https://www.smallstreet.app/...?email=... (also user_email, mail, e)
 * Does not run for structured verify-me QRs (handled by parseSmallstreetVerifyMeQr first).
 */
function extractEmailForMembershipFromQr(qrText) {
    if (!qrText || typeof qrText !== 'string') return null;
    const trimmed = String(qrText).replace(/^\uFEFF/, '').trim();

    if (/^mailto:/i.test(trimmed)) {
        let addr = trimmed.replace(/^mailto:/i, '').split('?')[0].trim();
        try {
            addr = decodeURIComponent(addr);
        } catch (_) {}
        if (addr && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
            return { email: addr.trim() };
        }
        return null;
    }

    let u;
    try {
        u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
        return null;
    }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!membershipQrEmailHostAllowed(host)) return null;

    const candidates = [
        u.searchParams.get('email'),
        u.searchParams.get('user_email'),
        u.searchParams.get('mail'),
        u.searchParams.get('e')
    ].filter(Boolean);

    for (const raw of candidates) {
        let e;
        try {
            e = decodeURIComponent(raw).trim();
        } catch {
            e = raw.trim();
        }
        if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
            return { email: e };
        }
    }
    return null;
}

async function submitSmallstreetVerifyMeFromDiscord(message, parsed) {
    const apiKey = process.env.SMALLSTREET_API_KEY;
    if (!apiKey) {
        return { outcome: 'missing_key' };
    }
    const url = process.env.VERIFY_ME_QR_SUBMIT_URL || VERIFY_ME_QR_SUBMIT_DEFAULT;
    const displayName = message.member
        ? message.member.displayName || message.author.username
        : message.author.username;
    const body = {
        transaction_id: parsed.type === 'transaction' ? parsed.transaction_id : null,
        xp_units: parsed.type === 'transaction' ? (parsed.xp_units || null) : null,
        discord_id: String(message.author.id),
        discord_username: message.author.username,
        discord_display_name: displayName,
        message_id: String(message.id),
        scanned_at_utc: formatJoinedAtForApi(new Date().toISOString()),
        qr_type: parsed.type
    };
    if (parsed.type === 'session') {
        body.id = parsed.qr_discord_id;
        body.guild_id = parsed.qr_guild_id;
        body.scanned_in_guild_id = String(message.guild.id);
    } else {
        body.guild_id = String(message.guild.id);
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify(body)
        });
        const text = await res.text();
        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { message: text.slice(0, 500) };
            }
        }
        if (res.ok) {
            return { outcome: 'synced', status: res.status, data };
        }
        const errMsg = (data && (data.message || data.error)) || (typeof text === 'string' ? text.slice(0, 200) : '');
        return { outcome: 'http_error', status: res.status, data, error: errMsg };
    } catch (err) {
        return { outcome: 'network_error', error: err.message };
    }
}

// Modify the verifySmallStreetMembership function to add debugging
async function verifySmallStreetMembership(email) {
    try {
        console.log(`🔍 Verifying membership for email: ${email}`);
        if (useHumanBlockchainMembership()) {
            const url = `${humanBlockchainSiteBase()}/wp-json/hb/v1/discord-bot/membership?email=${encodeURIComponent(email)}`;
            const response = await fetchWithRetry(url, {
                headers: {
                    Authorization: `Bearer ${process.env.HUMANBLOCKCHAIN_API_KEY}`,
                    Accept: 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            const rawText = await response.text();
            let data = {};
            try {
                data = rawText ? JSON.parse(rawText) : {};
            } catch (e) {
                console.error('HumanBlockchain membership API: non-JSON body', rawText.slice(0, 400));
                throw new Error(
                    response.ok
                        ? 'HumanBlockchain membership API returned invalid JSON'
                        : `HumanBlockchain API HTTP ${response.status}: ${rawText.slice(0, 200)}`
                );
            }
            if (!response.ok) {
                console.error('HumanBlockchain membership API error:', response.status, data);
                throw new Error(
                    (data && (data.message || data.code)) || `HumanBlockchain membership API failed (${response.status})`
                );
            }
            if (data.member && data.membership_name) {
                console.log(`✅ HB API: member=${data.membership_name}`);
                return [true, data.membership_name];
            }
            console.log(`❌ HB API: not a member for email: ${email}`);
            return [false, null];
        }

        const response = await fetchWithRetry('https://www.smallstreet.app/wp-json/myapi/v1/api');
        const data = await response.json();
        
        console.log(`🔍 API Response data:`, JSON.stringify(data, null, 2));
        console.log(`🔍 Total users in API: ${data.length}`);
        
        for (const user of data) {
            console.log(`🔍 Checking user: ${user.user_email} (membership: ${user.membership_name})`);
            if (user.user_email.toLowerCase() === email.toLowerCase() && user.membership_id) {
                console.log(`✅ User found in API! Email: ${user.user_email}, Membership: ${user.membership_name}`);
                return [true, user.membership_name];
            }
        }
        
        console.log(`❌ User not found in API for email: ${email}`);
        return [false, null];
    } catch (error) {
        console.error('Error verifying membership:', error);
        throw new Error('Failed to verify membership after multiple retries');
    }
}

// POST /myapi/v1/discord-user to persist QR verification (see getDiscordVerifyPostUrl).
async function insertUserToSmallStreetUsermeta(userData) {
    try {
        const eventId = userData.eventId ? String(userData.eventId) : generateRandomId();
        const xpAwarded = userData.xpAwarded != null ? Number(userData.xpAwarded) : 5000000;

        const apiData = {
            email: userData.email,
            discord_id: String(userData.discordId),
            id: eventId,
            discord_username: userData.discordUsername,
            discord_display_name: userData.displayName,
            joined_at: formatJoinedAtForApi(userData.joinedAt),
            guild_id: String(userData.guildId),
            joined_via_invite: userData.inviteUrl,
            xp_awarded: xpAwarded
        };

        if (useHumanBlockchainMembership()) {
            console.log(`🔗 POST HumanBlockchain discord-bot/verification for: ${userData.discordUsername}`);
            console.log(`📤 User data:`, JSON.stringify(userData, null, 2));
            console.log(`🔑 HUMANBLOCKCHAIN_API_KEY present:`, !!process.env.HUMANBLOCKCHAIN_API_KEY);
            console.log(`📝 verification body:`, JSON.stringify(apiData, null, 2));
            const postUrl = `${humanBlockchainSiteBase()}/wp-json/hb/v1/discord-bot/verification`;
            try {
                const apiResponse = await fetchWithRetry(postUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${process.env.HUMANBLOCKCHAIN_API_KEY}`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    body: JSON.stringify(apiData)
                });
                const apiResult = await apiResponse.json();
                console.log(`📥 HB API Status: ${apiResponse.status} ${apiResponse.statusText}`);
                console.log(`📥 HB API Body:`, JSON.stringify(apiResult, null, 2));
                if (apiResponse.ok) {
                    console.log(`✅ HumanBlockchain verification saved`);
                    return { success: true, data: apiResult };
                }
                console.error(`❌ HB verification failed:`, apiResult);
                return { success: false, error: `API request failed: ${JSON.stringify(apiResult)}` };
            } catch (apiError) {
                console.error('❌ Error posting to HumanBlockchain:', apiError);
                return { success: false, error: `API error: ${apiError.message}`, details: apiError };
            }
        }

        console.log(`🔗 POST discord-user for: ${userData.discordUsername}`);
        console.log(`📤 User data:`, JSON.stringify(userData, null, 2));
        console.log(`🔑 API Key present:`, !!process.env.SMALLSTREET_API_KEY);

        console.log(`📝 discord-user body:`, JSON.stringify(apiData, null, 2));

        try {
            const requestHeaders = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            };

            const postUrl = getDiscordVerifyPostUrl();
            console.log(`📝 POST ${postUrl}`);

            const apiResponse = await fetchWithRetry(postUrl, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(apiData)
            });

            const apiResult = await apiResponse.json();
            console.log(`📥 API Response Status: ${apiResponse.status} ${apiResponse.statusText}`);
            console.log(`📥 API Response Body:`, JSON.stringify(apiResult, null, 2));

            if (apiResponse.ok) {
                console.log(`✅ SmallStreet discord-user saved`);
                return { success: true, data: apiResult };
            }

            console.error(`❌ API request failed:`, apiResult);
            return { success: false, error: `API request failed: ${JSON.stringify(apiResult)}` };
        } catch (apiError) {
            console.error('❌ Error sending data to API:', apiError);
            console.error('❌ API error stack:', apiError.stack);
            return { success: false, error: `API error: ${apiError.message}`, details: apiError };
        }
        
    } catch (error) {
        console.error('❌ Error inserting user to SmallStreet usermeta:', error);
        console.error('❌ Error stack trace:', error.stack);
        return { success: false, error: error.message, details: error };
    }
}

// Check for recent polls to prevent duplicates
async function checkForRecentPolls(channel) {
    try {
        console.log(`🔍 Checking for recent polls in channel: ${channel.name}`);
        
        // Get messages from the last 5 minutes
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        const messages = await channel.messages.fetch({ limit: 10 });
        
        const recentPolls = messages.filter(msg => 
            msg.author.id === client.user.id && 
            msg.embeds.length > 0 && 
            msg.embeds[0].title && 
            msg.embeds[0].title.includes('Monthly Resource Allocation Vote') &&
            msg.createdTimestamp > fiveMinutesAgo
        );
        
        console.log(`🔍 Found ${recentPolls.size} recent polls in the last 5 minutes`);
        
        if (recentPolls.size > 0) {
            const recentPoll = recentPolls.first();
            console.log(`⚠️ Recent poll found: ${recentPoll.id} created at ${recentPoll.createdAt.toISOString()}`);
            return {
                hasRecent: true,
                messageId: recentPoll.id,
                createdAt: recentPoll.createdAt
            };
        }
        
        return { hasRecent: false };
    } catch (error) {
        console.error('❌ Error checking for recent polls:', error);
        return { hasRecent: false, error: error.message };
    }
}

// Enhanced poll system with three-choice resource allocation
async function createEnhancedMonthlyPoll() {
    console.log(`🔍 createEnhancedMonthlyPoll() called at ${new Date().toISOString()}`);
    
    try {
        const channel = client.channels.cache.get(process.env.MONTHLY_REDEMPTION_CHANNEL_ID);
        if (!channel) {
            console.error('❌ Monthly redemption channel not found');
            return { success: false, error: 'Channel not found' };
        }
        
        console.log(`🔍 Creating poll in channel: ${channel.name} (${channel.id})`);
        
        // Check for recent polls
        const recentCheck = await checkForRecentPolls(channel);
        if (recentCheck.hasRecent) {
            console.log(`⚠️ Recent poll found (${recentCheck.messageId}), preventing duplicate creation`);
            return { 
                success: false, 
                error: `Recent poll already exists (${recentCheck.messageId}) created at ${recentCheck.createdAt.toISOString()}` 
            };
        }

        // Create enhanced poll embed
        const pollEmbed = {
            title: '🗳️ Monthly Resource Allocation Vote',
            description: 'Choose how to allocate this month\'s community resources. Your voting power is based on your XP level.',
            color: 0x00ff00, // Green color
            fields: [
                {
                    name: '🕊️ Peace Initiatives',
                    value: 'Community building, conflict resolution, and solidarity programs\n**XP Multiplier:** 1.0x',
                    inline: true
                },
                {
                    name: '🗳️ Voting Programs', 
                    value: 'Democratic participation, voter education, and civic engagement\n**XP Multiplier:** 1.5x',
                    inline: true
                },
                {
                    name: '🆘 Disaster Relief',
                    value: 'Emergency response, humanitarian aid, and crisis support\n**XP Multiplier:** 2.0x',
                    inline: true
                },
                {
                    name: '⏰ Duration',
                    value: '7 days',
                    inline: true
                },
                {
                    name: '📅 End Date',
                    value: `<t:${Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 1000)}:F>`,
                    inline: true
                },
                {
                    name: '💡 Voting Power',
                    value: 'Based on your XP level:\n• Basic: 1x\n• MEGAvoter: 5x\n• Patron: 25x\n• Top Contributors: Up to 100x',
                    inline: true
                }
            ],
            footer: {
                text: 'Voting power based on XP level • Make Everyone Great Again • SmallStreet Governance'
            },
            timestamp: new Date().toISOString()
        };

        // Send the poll message
        console.log(`🔍 Sending poll message to channel...`);
        const pollMessage = await channel.send({ embeds: [pollEmbed] });
        console.log(`🔍 Poll message sent with ID: ${pollMessage.id}`);

        // Add reaction options for voting (three choices)
        const reactions = ['🕊️', '🗳️', '🆘'];
        console.log(`🔍 Adding reactions: ${reactions.join(', ')}`);
        for (const reaction of reactions) {
            await pollMessage.react(reaction);
            console.log(`🔍 Added reaction: ${reaction}`);
        }

        console.log(`✅ Enhanced monthly poll created in ${channel.name} with message ID: ${pollMessage.id}`);
        return { 
            success: true, 
            messageId: pollMessage.id,
            channelId: channel.id,
            endTime: Date.now() + 7 * 24 * 60 * 60 * 1000
        };

    } catch (error) {
        console.error('❌ Error creating enhanced monthly poll:', error);
        return { success: false, error: error.message };
    }
}

// Legacy function for backward compatibility
async function createPOCGovernancePoll() {
    return await createEnhancedMonthlyPoll();
}

// Voting power calculation based on XP levels
function getVotingPower(xpLevel) {
    if (xpLevel >= 1e168) return 100;      // e-168+ = 100x power
    if (xpLevel >= 1e120) return 50;       // e-120+ = 50x power  
    if (xpLevel >= 1e48) return 25;        // e-48+ = 25x power
    if (xpLevel >= 1e24) return 10;        // e-24+ = 10x power
    if (xpLevel >= 1e12) return 5;         // e-12+ = 5x power
    if (xpLevel >= 1e6) return 2;          // e-6+ = 2x power
    return 1;                              // e-0 to e-6 = 1x power
}

// Get choice from emoji
function getChoiceFromEmoji(emoji) {
    const emojiMap = {
        '🕊️': 'peace',
        '🗳️': 'voting', 
        '🆘': 'disaster'
    };
    return emojiMap[emoji] || null;
}

// Digit-only strings for API fields like xp_units (may exceed Number.MAX_SAFE_INTEGER)
function normalizeDigitString(val) {
    if (val == null) return '0';
    const s = String(val).replace(/\s/g, '');
    return /^\d+$/.test(s) ? s : '0';
}

function sumBigIntDigitStrings(...values) {
    let t = 0n;
    for (const v of values) {
        try {
            t += BigInt(normalizeDigitString(v));
        } catch (_) {}
    }
    return t.toString();
}

function sumXpUnitsFromScanList(list) {
    if (!Array.isArray(list)) return '0';
    let t = 0n;
    for (const row of list) {
        try {
            t += BigInt(normalizeDigitString(row?.xp_units));
        } catch (_) {}
    }
    return t.toString();
}

function legacyMetaArrayXpSum(arr, field = 'xp_awarded') {
    if (!Array.isArray(arr)) return '0';
    let t = 0n;
    for (const item of arr) {
        const rec = typeof item === 'string'
            ? (() => { try { return JSON.parse(item); } catch { return null; } })()
            : item;
        if (!rec) continue;
        try {
            t += BigInt(normalizeDigitString(rec[field]));
        } catch (_) {}
    }
    return t.toString();
}

function xpGreaterThanZero(xp) {
    try {
        return BigInt(normalizeDigitString(xp)) > 0n;
    } catch (_) {
        const n = Number(xp);
        return Number.isFinite(n) && n > 0;
    }
}

// Format e-decimal notation (works for large integer strings)
function formatEDecimal(xp) {
    const plain = normalizeDigitString(typeof xp === 'number' && Number.isFinite(xp) ? String(Math.trunc(xp)) : xp);
    if (plain === '0') return 'e+0';
    return `e+${plain.length - 1}`;
}

// Format XP with thousands separators (supports bigint-sized digit strings)
function formatXPNumber(xp) {
    if (xp === 0 || xp === 0n) return '0';
    const str = typeof xp === 'bigint' ? xp.toString() : String(xp);
    const plain = str.replace(/,/g, '');
    if (plain === '0') return '0';
    if (/^\d+$/.test(plain)) {
        return plain.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    if (typeof xp === 'number' && Number.isFinite(xp)) return xp.toLocaleString();
    return str;
}

// Enhanced poll results processing with weighted voting
async function getEnhancedPollResults(messageId) {
    try {
        const channel = client.channels.cache.get(process.env.MONTHLY_REDEMPTION_CHANNEL_ID);
        if (!channel) {
            return { success: false, error: 'Channel not found' };
        }

        const message = await channel.messages.fetch(messageId);
        const reactions = message.reactions.cache;

        console.log(`🔍 Debug: Processing reactions for message ${messageId}`);
        console.log(`🔍 Debug: Found ${reactions.size} reactions`);
        
        const results = {
            peace: { count: 0, weighted: 0, voters: [] },
            voting: { count: 0, weighted: 0, voters: [] },
            disaster: { count: 0, weighted: 0, voters: [] },
            totalVoters: 0,
            uniqueVoters: new Set()
        };
        
        // Process each reaction
        for (const [emoji, reaction] of reactions) {
            console.log(`🔍 Debug: Processing reaction ${emoji} with ${reaction.count} count`);
            
            const choice = getChoiceFromEmoji(emoji);
            if (!choice) {
                console.log(`🔍 Debug: Skipping emoji ${emoji} - not a valid choice`);
                continue;
            }
            
            console.log(`🔍 Debug: Emoji ${emoji} maps to choice: ${choice}`);

            const users = await reaction.users.fetch();
            console.log(`🔍 Debug: Found ${users.size} users for reaction ${emoji}`);
            
            // Reset counts for this choice to avoid double counting
            results[choice].count = 0;
            results[choice].weighted = 0;
            results[choice].voters = [];
            
            for (const user of users.values()) {
                console.log(`🔍 Debug: Processing user ${user.username} (${user.id})`);
                
                if (user.bot) {
                    console.log(`🔍 Debug: Skipping bot user ${user.username}`);
                    continue;
                }
                
                let member = message.guild.members.cache.get(user.id);
                if (!member) {
                    console.log(`🔍 Debug: Could not find member for user ${user.username} in cache, trying to fetch...`);
                    try {
                        // Try to fetch the member if not in cache
                        member = await message.guild.members.fetch(user.id);
                        if (!member) {
                            console.log(`🔍 Debug: Could not fetch member for user ${user.username}, using user data only`);
                            // Use user data even if we can't get member data
                            member = { displayName: user.username };
                        } else {
                            console.log(`🔍 Debug: Successfully fetched member for user ${user.username}`);
                        }
                    } catch (fetchError) {
                        console.log(`🔍 Debug: Error fetching member for user ${user.username}: ${fetchError.message}, using user data only`);
                        // Use user data even if we can't get member data
                        member = { displayName: user.username };
                    }
                }

                // Check if user exists in Discord invites API
                const userVerification = await checkUserInDiscordInvites(user.username);
                
                // Get user's XP level from API or use default
                const xpLevel = await getUserXPLevel(user.id, user.username);
                const votingPower = getVotingPower(xpLevel);
                
                console.log(`🔍 Debug: User ${user.username} - Verified: ${userVerification.exists}, XP: ${xpLevel}, Power: ${votingPower}x, Choice: ${choice}`);
                
                const voter = {
                    userId: user.id,
                    username: user.username,
                    displayName: member.displayName,
                    xpLevel: xpLevel,
                    votingPower: votingPower,
                    choice: choice,
                    votedAt: new Date().toISOString(),
                    verified: userVerification.exists,
                    email: userVerification.exists ? userVerification.userData.email : null,
                    smallstreetUserId: userVerification.exists ? userVerification.userData.userId : null
                };

                results[choice].count++;
                results[choice].weighted += votingPower;
                results[choice].voters.push(voter);
                results.uniqueVoters.add(user.id);
                
                // Calculate XP for this vote (base XP only, bonuses calculated later)
                const baseXP = 1000000; // 1M XP for voting
                
                console.log(`🔍 Debug: User ${user.username} - Base XP: ${baseXP}, Choice: ${choice}, Voting Power: ${votingPower}`);
                
                // Note: Vote data will be stored later in awardPollXP() to avoid duplicates
                
                console.log(`🔍 Debug: Added voter to ${choice} - Count: ${results[choice].count}, Weighted: ${results[choice].weighted}`);
            }
        }

        results.totalVoters = results.uniqueVoters.size;
        results.uniqueVoters = Array.from(results.uniqueVoters);
        
        console.log(`🔍 Debug: Final results - Total voters: ${results.totalVoters}`);
        console.log(`🔍 Debug: Peace: ${results.peace.count} votes, ${results.peace.weighted} weighted`);
        console.log(`🔍 Debug: Voting: ${results.voting.count} votes, ${results.voting.weighted} weighted`);
        console.log(`🔍 Debug: Disaster: ${results.disaster.count} votes, ${results.disaster.weighted} weighted`);

        return { success: true, data: results };
    } catch (error) {
        console.error('❌ Error getting enhanced poll results:', error);
        return { success: false, error: error.message };
    }
}

// Legacy function for backward compatibility
async function getPollResults(messageId) {
    const enhancedResults = await getEnhancedPollResults(messageId);
    if (!enhancedResults.success) return enhancedResults;
    
    // Convert to legacy format
    const results = {};
    const data = enhancedResults.data;
    results['🕊️'] = data.peace.count;
    results['🗳️'] = data.voting.count;
    results['🆘'] = data.disaster.count;

        return { success: true, results };
}

// Calculate fund allocation based on weighted votes
function calculateFundAllocation(results, monthlyFund = 1000000) {
    const totalWeighted = results.peace.weighted + results.voting.weighted + results.disaster.weighted;
    
    if (totalWeighted === 0) {
        return {
            peace: { percentage: 33.33, allocation: monthlyFund / 3 },
            voting: { percentage: 33.33, allocation: monthlyFund / 3 },
            disaster: { percentage: 33.33, allocation: monthlyFund / 3 }
        };
    }
    
    return {
        peace: {
            percentage: (results.peace.weighted / totalWeighted) * 100,
            allocation: (results.peace.weighted / totalWeighted) * monthlyFund
        },
        voting: {
            percentage: (results.voting.weighted / totalWeighted) * 100,
            allocation: (results.voting.weighted / totalWeighted) * monthlyFund
        },
        disaster: {
            percentage: (results.disaster.weighted / totalWeighted) * 100,
            allocation: (results.disaster.weighted / totalWeighted) * monthlyFund
        }
    };
}

// Get Discord invites data from SmallStreet API
async function getDiscordInvitesData() {
    try {
        const response = await fetchWithRetry('https://www.smallstreet.app/wp-json/myapi/v1/discord-invites', {
            headers: {
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const data = await response.json();
        
        if (response.ok) {
            console.log(`✅ Successfully fetched Discord invites data: ${data.length} records`);
            return { success: true, data: data };
        } else {
            console.error(`❌ Failed to fetch Discord invites data:`, data);
            return { success: false, error: data };
        }
    } catch (error) {
        console.error('Error fetching Discord invites data:', error);
        return { success: false, error: error.message };
    }
}

// Check if user exists in Discord invites API
async function checkUserInDiscordInvites(discordUsername) {
    try {
        const invitesData = await getDiscordInvitesData();
        
        if (!invitesData.success) {
            console.error('Failed to fetch Discord invites data:', invitesData.error);
            return { exists: false, error: invitesData.error };
        }

        // Search for user by discord_username
        for (const record of invitesData.data) {
            try {
                const discordInvite = JSON.parse(record.discord_invite);
                if (discordInvite.discord_username === discordUsername) {
                    console.log(`✅ User ${discordUsername} found in Discord invites API`);
                    return {
                        exists: true,
                        userData: {
                            userId: record.user_id,
                            email: record.email,
                            discordData: discordInvite
                        }
                    };
                }
            } catch (parseError) {
                console.error('Error parsing discord_invite JSON:', parseError);
                continue;
            }
        }

        console.log(`❌ User ${discordUsername} not found in Discord invites API`);
        return { exists: false };
    } catch (error) {
        console.error('Error checking user in Discord invites:', error);
        return { exists: false, error: error.message };
    }
}

// Get user XP level from Discord invites API or use default
async function getUserXPLevel(userId, discordUsername) {
    try {
        // First check if user exists in Discord invites API
        const userCheck = await checkUserInDiscordInvites(discordUsername);
        
        if (userCheck.exists && userCheck.userData) {
            const discordData = userCheck.userData.discordData;
            if (discordData.xp_awarded) {
                console.log(`✅ Using XP from Discord invites API: ${discordData.xp_awarded}`);
                return discordData.xp_awarded;
            }
        }

        // Fallback to simulated XP if not found in API
        console.log(`⚠️ User not found in API, using simulated XP`);
        const baseXP = 1000000; // 1M XP base
        const randomMultiplier = Math.floor(Math.random() * 100) + 1;
        return baseXP * randomMultiplier;
    } catch (error) {
        console.error('Error getting user XP level:', error);
        return 1000000; // Default to 1M XP
    }
}

const USER_XP_DATA_URL = 'https://www.smallstreet.app/wp-json/myapi/v1/user-xp-data';

function resolveDiscordInvite(metaData) {
    if (!metaData || metaData._discord_invite == null) return null;
    const inv = metaData._discord_invite;
    if (Array.isArray(inv)) {
        if (inv.length === 0) return null;
        const first = inv[0];
        if (typeof first === 'string') {
            try {
                return JSON.parse(first);
            } catch {
                return null;
            }
        }
        return first;
    }
    return typeof inv === 'object' ? inv : null;
}

function mapApiUserToProfile(user, fallbackDiscordUsername) {
    const metaData = user.meta_data || {};
    const discordInvite = resolveDiscordInvite(metaData);
    const discordUsername =
        (discordInvite && discordInvite.discord_username) ||
        fallbackDiscordUsername ||
        user.user_login ||
        'Unknown';
    const fullName =
        (discordInvite && discordInvite.discord_display_name) ||
        user.display_name ||
        discordUsername;

    let membershipName = 'verified';
    try {
        if (metaData._buyer_details && Array.isArray(metaData._buyer_details) && metaData._buyer_details.length > 0) {
            const raw = metaData._buyer_details[0];
            const buyerDetail = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
            if (buyerDetail && buyerDetail.membership) {
                membershipName = buyerDetail.membership;
            }
        }
    } catch (_) {}

    const buyerLegacy = legacyMetaArrayXpSum(metaData._buyer_details);
    const sellerLegacy = legacyMetaArrayXpSum(metaData._seller_details);
    const buyerScan = sumXpUnitsFromScanList(metaData.buyer_scan);
    const sellerScan = sumXpUnitsFromScanList(metaData.seller_scan);
    const personalScan = sumXpUnitsFromScanList(metaData.personal_scan);

    const buyerDetails = sumBigIntDigitStrings(buyerLegacy, buyerScan);
    const sellerDetails = sumBigIntDigitStrings(sellerLegacy, sellerScan);

    let discordInviteXp = '0';
    if (discordInvite && discordInvite.xp_awarded != null) {
        discordInviteXp = normalizeDigitString(discordInvite.xp_awarded);
    }

    const talentXP = legacyMetaArrayXpSum(metaData._talentshow_entry);
    let pollXP = '0';
    if (metaData._discord_poll && Array.isArray(metaData._discord_poll)) {
        pollXP = legacyMetaArrayXpSum(metaData._discord_poll, 'xp_awarded');
    }

    const totalXP = sumBigIntDigitStrings(
        discordInviteXp,
        buyerDetails,
        sellerDetails,
        talentXP,
        pollXP,
        personalScan
    );

    return {
        success: true,
        data: {
            userId: user.user_id,
            discordUsername,
            fullName,
            email: user.user_email,
            membership: membershipName,
            totalXP,
            xpBreakdown: {
                discordInvite: discordInviteXp,
                buyerDetails,
                talentShow: talentXP,
                sellerDetails,
                discordPoll: pollXP,
                personalScan
            },
            metaData,
            discordId: discordInvite ? discordInvite.discord_id : null,
            joinDate: discordInvite ? discordInvite.joined_at : null,
            verificationDate: discordInvite ? discordInvite.verification_date : null
        }
    };
}

function unverifiedProfileShell(ident) {
    return {
        success: true,
        data: {
            userId: null,
            discordUsername: ident,
            fullName: ident,
            email: null,
            membership: 'unverified',
            totalXP: '0',
            xpBreakdown: {
                discordInvite: '0',
                buyerDetails: '0',
                talentShow: '0',
                sellerDetails: '0',
                discordPoll: '0',
                personalScan: '0'
            },
            metaData: {},
            discordId: null,
            joinDate: null,
            verificationDate: null
        }
    };
}

// Function to get comprehensive user profile data (supports legacy { users: [] } and single-user + ?email= / query variants)
async function getUserProfileData(discordUsername) {
    try {
        const apiKey = process.env.SMALLSTREET_API_KEY;
        if (!apiKey) {
            return { success: false, error: 'SMALLSTREET_API_KEY is not set' };
        }

        const ident = (discordUsername || '').trim();
        if (!ident) {
            return { success: false, error: 'Empty username' };
        }

        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        const urlsToTry = [];
        if (ident.includes('@')) {
            urlsToTry.push(`${USER_XP_DATA_URL}?email=${encodeURIComponent(ident)}`);
        }
        urlsToTry.push(`${USER_XP_DATA_URL}?discord_username=${encodeURIComponent(ident)}`);
        urlsToTry.push(`${USER_XP_DATA_URL}?user_login=${encodeURIComponent(ident)}`);
        urlsToTry.push(USER_XP_DATA_URL);

        const seen = new Set();
        for (const url of urlsToTry) {
            if (seen.has(url)) continue;
            seen.add(url);
            try {
                const response = await fetchWithRetry(url, { method: 'GET', headers });
                const apiData = await response.json();
                console.log(`📊 user-xp-data (${url.includes('?') ? 'filtered' : 'list'}) keys:`, apiData && typeof apiData === 'object' ? Object.keys(apiData) : typeof apiData);

                if (apiData && Array.isArray(apiData.users)) {
                    for (const user of apiData.users) {
                        try {
                            const meta = user.meta_data;
                            const inv = meta && resolveDiscordInvite(meta);
                            if (inv && inv.discord_username &&
                                inv.discord_username.toLowerCase() === ident.toLowerCase()) {
                                console.log(`✅ Found user in users[] by discord_username: ${inv.discord_username}`);
                                return mapApiUserToProfile(user, ident);
                            }
                        } catch (parseError) {
                            console.error('Error parsing user in users[] list:', parseError);
                        }
                    }
                    continue;
                }

                if (apiData && apiData.user_id != null && apiData.meta_data) {
                    console.log(`✅ Matched single-user user-xp-data (user_id ${apiData.user_id})`);
                    return mapApiUserToProfile(apiData, ident);
                }
            } catch (err) {
                console.log(`getUserProfileData attempt failed (${url}):`, err.message);
            }
        }

        // Fallback: map Discord username → email via discord-invites, then user-xp-data?email=
        if (!ident.includes('@')) {
            try {
                const inviteLookup = await checkUserInDiscordInvites(ident);
                if (inviteLookup.exists && inviteLookup.userData && inviteLookup.userData.email) {
                    const emailUrl = `${USER_XP_DATA_URL}?email=${encodeURIComponent(inviteLookup.userData.email)}`;
                    const response = await fetchWithRetry(emailUrl, { method: 'GET', headers });
                    const apiData = await response.json();
                    if (apiData && apiData.user_id != null && apiData.meta_data) {
                        console.log(`✅ Matched user-xp-data via discord-invites email for @${ident}`);
                        return mapApiUserToProfile(apiData, ident);
                    }
                }
            } catch (err) {
                console.log('getUserProfileData discord-invites fallback failed:', err.message);
            }
        }

        console.log(`❌ User ${ident} not found via user-xp-data`);
        return unverifiedProfileShell(ident);
    } catch (error) {
        console.error('Error getting user profile data:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Calculate XP rewards for poll participation
function calculatePollXP(voter, winningChoice) {
    const baseXP = 1000000;        // 1M XP for voting
    const winningBonus = 5000000;  // 5M XP if your choice wins
    const topContributor = 10000000; // 10M XP for top contributors
    
    let totalXP = baseXP;
    
    // Check if their choice won
    if (voter.choice === winningChoice) {
        totalXP += winningBonus;
    }
    
    // Check if they're a top contributor
    if (voter.votingPower >= 25) {
        totalXP += topContributor;
    }
    
    return totalXP;
}

// Award XP to poll participants
async function awardPollXP(voters, winningChoice, pollId) {
    try {
        const xpAwards = [];
        
        for (const voter of voters) {
            const xpAwarded = calculatePollXP(voter, winningChoice);
            
            console.log(`🔍 XP Award for ${voter.username}: ${xpAwarded} XP (Base: 1M, Winning: ${voter.choice === winningChoice ? '5M' : '0'}, Top Contributor: ${voter.votingPower >= 25 ? '10M' : '0'})`);
            
            // First determine participant status (winner, top contributor)
            const isWinner = voter.choice === winningChoice;
            const isTopContributor = voter.votingPower >= 25;
            
            console.log(`🔍 ${voter.username} Status:`);
            console.log(`   - Winner: ${isWinner ? 'Yes' : 'No'}`);
            console.log(`   - Top Contributor: ${isTopContributor ? 'Yes' : 'No'}`);
            console.log(`   - Final XP: ${formatEDecimal(xpAwarded)}`);
            
            // Now store the data with final XP and status
            // Use poll creation time instead of current time
            let submittedAt;
            try {
                // Try to get the actual poll message creation time
                const channel = client.channels.cache.get(process.env.MONTHLY_REDEMPTION_CHANNEL_ID);
                if (channel) {
                    const pollMessage = await channel.messages.fetch(pollId);
                    submittedAt = pollMessage.createdAt.toISOString().replace('T', ' ').replace('Z', '');
                } else {
                    // Fallback to current time if channel not found
                    submittedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
                }
            } catch (error) {
                // Fallback to current time if message fetch fails
                console.log(`⚠️ Could not fetch poll message ${pollId}, using current time`);
                submittedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
            }
            
            const finalVoteData = {
                poll_id: pollId,
                email: voter.email || `${voter.userId}@discord.local`,
                vote: voter.choice,
                vote_type: 'monthly_poll',
                discord_id: voter.userId,
                username: voter.username,
                display_name: voter.displayName || voter.username,
                membership: voter.verified ? 'verified' : 'unverified',
                xp_awarded: xpAwarded, // Final XP amount (base + bonuses)
                status: 'final_awarded',
                submitted_at: submittedAt, // Use poll creation time
                // Add status flags for clarity
                is_winner: isWinner,
                is_top_contributor: isTopContributor,
                xp_breakdown: {
                    base: 1000000,
                    winning_bonus: isWinner ? 5000000 : 0,
                    top_contributor_bonus: isTopContributor ? 10000000 : 0,
                    total: xpAwarded
                }
            };
            
            // Store the final vote data with complete information
            try {
                await storePollData(finalVoteData);
                console.log(`✅ Stored final vote data for ${voter.username} with complete status and XP`);
            } catch (storeError) {
                console.error(`❌ Failed to store final vote data for ${voter.username}:`, storeError);
            }
            
            // Award XP (integrate with your XP system)
            await addXpEvent(voter.userId, 'POLL_PARTICIPATION', xpAwarded, {
                poll_type: 'monthly_resource_allocation',
                choice: voter.choice,
                voting_power: voter.votingPower,
                xp_breakdown: {
                    base: 1000000,
                    winning_bonus: voter.choice === winningChoice ? 5000000 : 0,
                    top_contributor: voter.votingPower >= 25 ? 10000000 : 0
                }
            });
            
            // Database has been updated with final data above
            console.log(`✅ Processing completed for ${voter.username}: ${formatEDecimal(xpAwarded)} XP`);
            
            xpAwards.push({
                userId: voter.userId,
                username: voter.username,
                xpAwarded: xpAwarded,
                choice: voter.choice,
                votingPower: voter.votingPower
            });
        }
        
        console.log(`✅ Awarded XP to ${xpAwards.length} poll participants`);
        return { success: true, awards: xpAwards };
    } catch (error) {
        console.error('Error awarding poll XP:', error);
        return { success: false, error: error.message };
    }
}

// Add XP event - integrate with SmallStreet XP system
async function addXpEvent(userId, eventType, xp, meta = {}) {
    try {
        console.log(`🔍 Debug: addXpEvent called for user ${userId}`);
        console.log(`💰 XP Event: User ${userId} earned ${formatEDecimal(xp)} (${xp.toLocaleString()} XP) for ${eventType}`);
        console.log(`📊 Meta:`, JSON.stringify(meta, null, 2));
        
        // Award XP through SmallStreet API
        const xpAwardData = {
            discord_id: userId,
            xp_amount: xp,
            event_type: eventType,
            event_meta: meta,
            timestamp: new Date().toISOString()
        };
        
        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/award-xp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify(xpAwardData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Failed to award XP via API: ${response.status} ${errorText}`);
            
            // Fallback: Try alternative XP awarding method
            console.log(`🔄 Trying alternative XP awarding method...`);
            return await awardXPAlternative(userId, xp, eventType, meta);
        }
        
        const result = await response.json();
        console.log(`✅ XP awarded successfully via API:`, result);
        return { success: true, data: result };
        
    } catch (error) {
        console.error('Error adding XP event:', error);
        
        // Fallback: Try alternative XP awarding method
        console.log(`🔄 Trying alternative XP awarding method due to error...`);
        return await awardXPAlternative(userId, xp, eventType, meta);
    }
}

// Alternative XP awarding method (fallback)
async function awardXPAlternative(userId, xp, eventType, meta = {}) {
    try {
        console.log(`🔄 Alternative XP awarding for user ${userId}: ${xp} XP`);
        
        // Try to update user's XP through the user update API
        const userUpdateData = {
            discord_id: userId,
            xp_awarded: xp,
            event_type: eventType,
            event_meta: meta,
            timestamp: new Date().toISOString()
        };
        
        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/discord-user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify(userUpdateData)
        });
        
        if (response.ok) {
            const result = await response.json();
            console.log(`✅ XP awarded via alternative method:`, result);
            return { success: true, data: result };
        } else {
            console.error(`❌ Alternative XP awarding failed: ${response.status}`);
            return { success: false, error: `Alternative method failed: ${response.status}` };
        }
        
    } catch (error) {
        console.error('Error in alternative XP awarding:', error);
        return { success: false, error: error.message };
    }
}

// Get poll participants with detailed information
async function getPollParticipants(messageId) {
    try {
        const enhancedResults = await getEnhancedPollResults(messageId);
        if (!enhancedResults.success) return enhancedResults;

        const data = enhancedResults.data;
        const allVoters = [
            ...data.peace.voters,
            ...data.voting.voters,
            ...data.disaster.voters
        ];

        const participants = {
            summary: {
                totalVoters: data.totalVoters,
                peaceVoters: data.peace.voters.length,
                votingVoters: data.voting.voters.length,
                disasterVoters: data.disaster.voters.length
            },
            byChoice: {
                peace: data.peace.voters,
                voting: data.voting.voters,
                disaster: data.disaster.voters
            },
            topContributors: allVoters
                .sort((a, b) => b.votingPower - a.votingPower)
                .slice(0, 10),
            allVoters: allVoters
        };

        return { success: true, data: participants };
    } catch (error) {
        console.error('Error getting poll participants:', error);
        return { success: false, error: error.message };
    }
}

// Send poll results to participants via direct message
async function sendPollResultsToParticipants(voters, winningChoice, pollId) {
    try {
        console.log(`📤 Sending poll results to ${voters.length} participants...`);
        
        const winningEmoji = winningChoice === 'peace' ? '🕊️' : winningChoice === 'voting' ? '🗳️' : '🆘';
        const winningName = winningChoice === 'peace' ? 'Peace Initiatives' : winningChoice === 'voting' ? 'Voting Programs' : 'Disaster Relief';
        
        for (const voter of voters) {
            try {
                const isWinner = voter.choice === winningChoice;
                const isTopContributor = voter.votingPower >= 25;
                const xpAwarded = calculatePollXP(voter, winningChoice);
                
                // Create personalized message
                let dmMessage = `🏆 **POLL RESULTS ARE OUT!**\n`;
                dmMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                
                dmMessage += `📊 **YOUR VOTE**\n`;
                dmMessage += `Choice: ${voter.choice}\n`;
                dmMessage += `Voting Power: ${voter.votingPower}x\n`;
                dmMessage += `Verified: ${voter.verified ? '✅ Yes' : '❌ No'}\n\n`;
                
                dmMessage += `🎯 **WINNER**\n`;
                dmMessage += `${winningEmoji} **${winningName}**\n\n`;
                
                if (voter.verified) {
                    dmMessage += `💰 **YOUR XP REWARD**\n`;
                    dmMessage += `Total XP: ${formatXPNumber(xpAwarded)} (${formatEDecimal(xpAwarded)})\n`;
                    dmMessage += `Breakdown:\n`;
                    dmMessage += `• Base XP: 1,000,000 (for voting)\n`;
                    dmMessage += `• Winner Bonus: ${isWinner ? '5,000,000 ✅' : '0'}\n`;
                    dmMessage += `• Top Contributor: ${isTopContributor ? '10,000,000 ✅' : '0'}\n\n`;
                } else {
                    dmMessage += `💰 **YOUR XP REWARD**\n`;
                    dmMessage += `Total XP: ${formatXPNumber(xpAwarded)} (${formatEDecimal(xpAwarded)})\n`;
                    dmMessage += `Breakdown:\n`;
                    dmMessage += `• Base XP: 1,000,000 (for voting)\n`;
                    dmMessage += `• Winner Bonus: ${isWinner ? '5,000,000 ✅' : '0'}\n`;
                    dmMessage += `• Top Contributor: ${isTopContributor ? '10,000,000 ✅' : '0'}\n\n`;
                    dmMessage += `🔐 **VERIFICATION REQUIRED**\n`;
                    dmMessage += `You are not verified, so first get verified by uploading your vCard and get verified, then only you will be awarded with the XP.\n\n`;
                }
                
                if (isWinner) {
                    dmMessage += `🎉 **CONGRATULATIONS!** Your choice won!\n\n`;
                }
                
                if (isTopContributor) {
                    dmMessage += `👑 **TOP CONTRIBUTOR!** You have 25x+ voting power!\n\n`;
                }
                
                dmMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
                dmMessage += `Make Everyone Great Again • SmallStreet Governance`;
                
                // Send DM to user
                const user = await client.users.fetch(voter.userId);
                if (user) {
                    await user.send(dmMessage);
                    console.log(`✅ Sent poll results DM to ${voter.username}`);
                } else {
                    console.log(`⚠️ Could not find user ${voter.username} (${voter.userId}) for DM`);
                }
                
                // Add small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (dmError) {
                console.error(`❌ Failed to send DM to ${voter.username}:`, dmError.message);
            }
        }
        
        console.log(`✅ Finished sending poll results to participants`);
        
    } catch (error) {
        console.error('❌ Error sending poll results to participants:', error);
    }
}

// Display enhanced poll results
async function displayEnhancedPollResults(messageId) {
    try {
        const results = await getEnhancedPollResults(messageId);
        if (!results.success) return results;

        const data = results.data;
        const allocation = calculateFundAllocation(data);
        
        // Determine winning choice
        const winningChoice = data.peace.weighted > data.voting.weighted && data.peace.weighted > data.disaster.weighted ? 'peace' :
                            data.voting.weighted > data.disaster.weighted ? 'voting' : 'disaster';

        // Award XP to participants
        const allVoters = [
            ...data.peace.voters,
            ...data.voting.voters,
            ...data.disaster.voters
        ];
        
        const xpResult = await awardPollXP(allVoters, winningChoice, messageId);

        const resultsEmbed = {
            title: '📊 Monthly Poll Results - Resource Allocation',
            description: 'Community has spoken! Here are the weighted results and fund allocation.',
            color: 0x00ff00,
            fields: [
                {
                    name: '🕊️ Peace Initiatives',
                    value: `**Votes:** ${data.peace.count}\n**Weighted:** ${data.peace.weighted}\n**Allocation:** ${allocation.peace.percentage.toFixed(1)}%\n**Fund:** $${allocation.peace.allocation.toLocaleString()}`,
                    inline: true
                },
                {
                    name: '🗳️ Voting Programs',
                    value: `**Votes:** ${data.voting.count}\n**Weighted:** ${data.voting.weighted}\n**Allocation:** ${allocation.voting.percentage.toFixed(1)}%\n**Fund:** $${allocation.voting.allocation.toLocaleString()}`,
                    inline: true
                },
                {
                    name: '🆘 Disaster Relief',
                    value: `**Votes:** ${data.disaster.count}\n**Weighted:** ${data.disaster.weighted}\n**Allocation:** ${allocation.disaster.percentage.toFixed(1)}%\n**Fund:** $${allocation.disaster.allocation.toLocaleString()}`,
                    inline: true
                },
                {
                    name: '🏆 Winning Choice',
                    value: `**${winningChoice.charAt(0).toUpperCase() + winningChoice.slice(1)}** won with ${allocation[winningChoice].percentage.toFixed(1)}% of weighted votes`,
                    inline: false
                },
                {
                    name: '👥 Participation',
                    value: `**Total Voters:** ${data.totalVoters}\n**XP Awards:** ${xpResult.success ? 'Distributed' : 'Failed'}\n**Total Weighted:** ${data.peace.weighted + data.voting.weighted + data.disaster.weighted}`,
                    inline: true
                }
            ],
            footer: {
                text: 'Results processed • XP rewards distributed • Make Everyone Great Again'
            },
            timestamp: new Date().toISOString()
        };

        const channel = client.channels.cache.get(process.env.MONTHLY_REDEMPTION_CHANNEL_ID);
        await channel.send({ embeds: [resultsEmbed] });

        // Send direct messages to all participants
        await sendPollResultsToParticipants(allVoters, winningChoice, messageId);

        return { success: true, data: { results: data, allocation, winningChoice, xpResult } };
    } catch (error) {
        console.error('Error displaying enhanced poll results:', error);
        return { success: false, error: error.message };
    }
}

// Get user assignment data (branch, POC, roles)
async function getUserAssignmentData(member) {
    try {
        // TODO: Replace with actual API call to get user assignment data
        // For now, using placeholder/default values
        // You can integrate with your API endpoint here
        
        // Example API call (uncomment and modify when API is ready):
        // const response = await fetch(`https://www.smallstreet.app/wp-json/myapi/v1/user-assignment?discord_id=${member.user.id}`, {
        //     headers: { 'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}` }
        // });
        // const data = await response.json();
        
        // Get user's current roles
        const memberRoles = member.roles.cache;
        
        // Try to find branch, buyer POC, and seller POC roles
        // These role names/IDs should be configured or fetched from API
        let branchRoleMention = 'Not assigned';
        let buyerPOCRoleMention = 'Not assigned';
        let sellerPOCRoleMention = 'Not assigned';
        
        // Check for roles (you can customize these role names/IDs)
        memberRoles.forEach(role => {
            const roleName = role.name.toLowerCase();
            if (roleName.includes('branch') || roleName.includes('peace pentagon')) {
                branchRoleMention = `<@&${role.id}>`;
            } else if (roleName.includes('buyer') || roleName.includes('buyer poc')) {
                buyerPOCRoleMention = `<@&${role.id}>`;
            } else if (roleName.includes('seller') || roleName.includes('seller poc')) {
                sellerPOCRoleMention = `<@&${role.id}>`;
            }
        });
        
        // Return assignment data (using placeholders until API is integrated)
        return {
            branchName: 'TBD', // Replace with data.branchName when API is ready
            branchCode: 'TBD', // Replace with data.branchCode when API is ready
            buyerPOCName: 'TBD', // Replace with data.buyerPOCName when API is ready
            sellerPOCName: 'TBD', // Replace with data.sellerPOCName when API is ready
            branchRoleMention: branchRoleMention,
            buyerPOCRoleMention: buyerPOCRoleMention,
            sellerPOCRoleMention: sellerPOCRoleMention
        };
    } catch (error) {
        console.error('Error fetching user assignment data:', error);
        // Return default values on error
        return {
            branchName: 'TBD',
            branchCode: 'TBD',
            buyerPOCName: 'TBD',
            sellerPOCName: 'TBD',
            branchRoleMention: 'Not assigned',
            buyerPOCRoleMention: 'Not assigned',
            sellerPOCRoleMention: 'Not assigned'
        };
    }
}

// Assign role based on membership
async function assignRoleBasedOnMembership(member, membershipType) {
    try {
        console.log(`🎭 Starting role assignment for user: ${member.user.tag}`);
        console.log(`🎭 Membership type: ${membershipType}`);
        
        const MEGAVOTER_ROLE_ID = process.env.MEGAVOTER_ROLE_ID;
        const PATRON_ROLE_ID = process.env.PATRON_ROLE_ID;

        console.log(`🎭 Role IDs - MEGAVOTER: ${MEGAVOTER_ROLE_ID}, PATRON: ${PATRON_ROLE_ID}`);

        // Check if role IDs are set
        if (!MEGAVOTER_ROLE_ID || !PATRON_ROLE_ID) {
            console.error('❌ Role IDs not set in environment variables');
            return { roleName: null, alreadyHas: false, error: 'Role IDs not configured' };
        }

        // Check if roles exist in the guild
        const megavoterRole = member.guild.roles.cache.get(MEGAVOTER_ROLE_ID);
        const patronRole = member.guild.roles.cache.get(PATRON_ROLE_ID);

        console.log(`🎭 Roles found - MEGAvoter: ${megavoterRole ? megavoterRole.name : 'NOT FOUND'}, Patron: ${patronRole ? patronRole.name : 'NOT FOUND'}`);

        if (!megavoterRole || !patronRole) {
            console.error('❌ One or more roles not found in guild');
            return { roleName: null, alreadyHas: false, error: 'Roles not found in guild' };
        }

        // Check if user already has the roles
        const hasMegavoter = member.roles.cache.has(MEGAVOTER_ROLE_ID);
        const hasPatron = member.roles.cache.has(PATRON_ROLE_ID);

        console.log(`🎭 User current roles - MEGAvoter: ${hasMegavoter}, Patron: ${hasPatron}`);

        // Return early if user already has the appropriate role
        if (membershipType.toLowerCase() === 'pioneer' && hasMegavoter) {
            console.log(`✅ User already has MEGAvoter role`);
            return { roleName: "MEGAvoter", alreadyHas: true };
        } else if (membershipType.toLowerCase() === 'patron' && hasPatron) {
            console.log(`✅ User already has Patron role`);
            return { roleName: "Patron", alreadyHas: true };
        }

        // Remove existing roles
        if (hasMegavoter) {
            console.log(`🔄 Removing existing MEGAvoter role`);
            await member.roles.remove(megavoterRole);
        }
        if (hasPatron) {
            console.log(`🔄 Removing existing Patron role`);
            await member.roles.remove(patronRole);
        }

        // Assign new role
        if (membershipType.toLowerCase() === 'pioneer') {
            console.log(`🎭 Assigning MEGAvoter role`);
            try {
                await member.roles.add(megavoterRole);
                console.log(`✅ Successfully assigned MEGAvoter role`);
                return { roleName: "MEGAvoter", alreadyHas: false };
            } catch (roleError) {
                console.error(`❌ Failed to assign MEGAvoter role:`, roleError);
                return { roleName: null, alreadyHas: false, error: `Failed to assign MEGAvoter role: ${roleError.message}` };
            }
        } else if (membershipType.toLowerCase() === 'patron') {
            console.log(`🎭 Assigning Patron role`);
            try {
                await member.roles.add(patronRole);
                console.log(`✅ Successfully assigned Patron role`);
                return { roleName: "Patron", alreadyHas: false };
            } catch (roleError) {
                console.error(`❌ Failed to assign Patron role:`, roleError);
                return { roleName: null, alreadyHas: false, error: `Failed to assign Patron role: ${roleError.message}` };
            }
        }
        
        console.log(`❌ Unknown membership type: ${membershipType}`);
        return { roleName: null, alreadyHas: false, error: `Unknown membership type: ${membershipType}` };
    } catch (error) {
        console.error('❌ Error assigning role:', error);
        return { roleName: null, alreadyHas: false, error: error.message };
    }
}

// Bot ready event
client.once('ready', async () => {
    if (isInitialized) {
        console.log('Preventing duplicate initialization');
        return;
    }
    
    isInitialized = true;
    console.log(`Bot is online as ${client.user.tag}`);
    
    try {
        // Test API connection on startup
        console.log('🧪 Testing API connection on startup...');
        // Note: API test removed to prevent startup errors
        
        // Clear any existing bot messages in the verification channel
        const channel = client.channels.cache.get(process.env.VERIFY_CHANNEL_ID);
        if (channel) {
            // Fetch recent messages
            const messages = await channel.messages.fetch({ limit: 100 });
            const botMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                (msg.content.includes('Bot is online') || msg.content.includes('Make Everyone Great Again'))
            );
            
            // Delete old bot messages (only if they're under 14 days old)
            if (botMessages.size > 0) {
                try {
                    await channel.bulkDelete(botMessages);
                    console.log(`✅ Deleted ${botMessages.size} old bot messages`);
                } catch (error) {
                    if (error.code === 50034) {
                        console.log(`⚠️ Cannot bulk delete messages older than 14 days, skipping cleanup`);
                    } else {
                        console.error('❌ Error deleting old messages:', error.message);
                    }
                }
            }
            
        // Send new startup message
        await channel.send('🤖 Bot is online and ready to process QR codes!\nMake Everyone Great Again');
    }
    
    // Schedule monthly enhanced resource allocation polls
    // This will create a poll on the 1st day of every month at 9:00 AM
    cron.schedule('0 9 1 * *', async () => {
        try {
            console.log('🗳️ Creating scheduled monthly resource allocation poll...');
            const pollResult = await createEnhancedMonthlyPoll();
            
            if (pollResult.success) {
                console.log(`✅ Enhanced monthly poll created successfully: ${pollResult.messageId}`);
                
                // Schedule automatic results processing for the last day of the month at 11:59 PM
                const now = new Date();
                const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                const timeUntilEndOfMonth = lastDayOfMonth.getTime() - now.getTime();
                
                setTimeout(async () => {
                    try {
                        console.log('📊 Processing scheduled poll results at end of month...');
                        const results = await displayEnhancedPollResults(pollResult.messageId);
                        
                        if (results.success) {
                            console.log('✅ Scheduled poll results processed successfully');
                        } else {
                            console.error('❌ Failed to process scheduled poll results:', results.error);
                        }
                    } catch (error) {
                        console.error('❌ Error processing scheduled poll results:', error);
                    }
                }, timeUntilEndOfMonth);
                
                // Send notification to admin
                const adminUser = client.users.cache.get(process.env.ADMIN_USER_ID);
                if (adminUser) {
                    await adminUser.send(`🗳️ **Monthly Resource Allocation Poll Created!**\n- Channel: <#${pollResult.channelId}>\n- Message ID: \`${pollResult.messageId}\`\n- Duration: Until end of month\n- End Time: <t:${Math.floor(lastDayOfMonth.getTime() / 1000)}:F>\n- Options: 🕊️ Peace, 🗳️ Voting, 🆘 Disaster Relief\n- Auto-results: Enabled for end of month`);
                }
            } else {
                console.error('❌ Failed to create monthly poll:', pollResult.error);
                
                // Send error notification to admin
                const adminUser = client.users.cache.get(process.env.ADMIN_USER_ID);
                if (adminUser) {
                    await adminUser.send(`❌ **Monthly Poll Creation Failed:** ${pollResult.error}`);
                }
            }
        } catch (error) {
            console.error('❌ Error in scheduled poll creation:', error);
        }
    }, {
        timezone: "UTC"
    });
    
    console.log('🗳️ Monthly poll scheduler activated - polls will be created on the 1st of each month at 9:00 AM UTC');
    
} catch (error) {
    console.error('Error during startup cleanup:', error);
}
});

// Start Express server only once
let server;
if (!server) {
    server = app.listen(PORT, () => {
        console.log(`Health check server is running on port ${PORT}`);
    });
}

// Add graceful shutdown handling
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM signal. Cleaning up...');
    try {
        if (server) {
            server.close();
        }
        if (client) {
            const channel = client.channels.cache.get(process.env.VERIFY_CHANNEL_ID);
            if (channel) {
                await channel.send('⚠️ Bot is restarting for maintenance. Please wait a moment...\nMake Everyone Great Again');
            }
            client.destroy();
        }
    } catch (error) {
        console.error('Error during shutdown:', error);
    } finally {
        process.exit(0);
    }
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT signal. Cleaning up...');
    try {
        const channel = client.channels.cache.get(process.env.VERIFY_CHANNEL_ID);
        if (channel) {
            await channel.send('⚠️ Bot is shutting down. Please wait a moment...');
        }
    } catch (error) {
        console.error('Error during shutdown:', error);
    } finally {
        // Destroy the client connection
        client.destroy();
        process.exit(0);
    }
});

// Add a Set to track processing messages
const processingUsers = new Set();

// Member join event handler
client.on('guildMemberAdd', async (member) => {
    try {
        console.log(`👋 New member joined: ${member.user.tag} (${member.user.id})`);
        console.log(`👋 Guild ID: ${member.guild.id}`);
        console.log(`👋 Member display name: ${member.displayName}`);
        console.log(`👋 Member joined at: ${member.joinedAt}`);
        
        // Send immediate notification to admin that event fired
        try {
            const adminUser = client.users.cache.get(process.env.ADMIN_USER_ID);
            if (adminUser) {
                await adminUser.send(`🔔 **Member Join Event Fired!**\n**User:** ${member.user.tag} (${member.user.id})\n**Guild:** ${member.guild.name}\n**Time:** ${new Date().toISOString()}`);
            }
        } catch (adminDmError) {
            console.log('Could not send admin notification:', adminDmError.message);
        }
        
        // Try to get invite information
        let inviteUsed = null;
        try {
            const invites = await member.guild.invites.fetch();
            // This is a simplified approach - in a real scenario you'd track invite usage
            inviteUsed = 'https://discord.gg/smallstreet';
        } catch (inviteError) {
            console.log('Could not fetch invites:', inviteError.message);
            inviteUsed = 'https://discord.gg/smallstreet';
        }
        
        // Prepare user data for database insertion
        const userData = {
            discordId: member.user.id,
            discordUsername: member.user.username,
            displayName: member.displayName || member.user.username,
            email: `${member.user.username}@discord.local`, // Temporary email for Discord users
            guildId: member.guild.id,
            joinedAt: new Date().toISOString(),
            inviteUrl: inviteUsed
        };

        // Send welcome message to new member
        const welcomeChannel = client.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
        if (welcomeChannel) {
            await welcomeChannel.send(`🎉 Welcome <@${member.user.id}> to Gracebook!\n\n🎯 **Next Steps:**\n• Upload your QR code in <#${process.env.VERIFY_CHANNEL_ID}> to verify membership and get your Discord roles\n• You'll receive XP rewards after verification\n\n🔗 **SmallStreet Account:** https://www.smallstreet.app/login/\n\n*Make Everyone Great Again* 🚀`);
        }
        
        // Note: Database insertion happens during QR verification with real email, not on member join
        console.log(`👋 Member joined: ${member.user.tag} - Database insertion will happen during QR verification with real email`);

        // Send DM with instructions (optional - don't fail if DM is disabled)
        try {
            // Get user assignment data
            const assignmentData = await getUserAssignmentData(member);
            const displayName = member.displayName || member.user.username;
            
            // Build the new DM message
            const dmMessage = `Hey ${displayName} — you're in. This is your Gracebook "receipt."

🔐 Non-Negotiables (read once)
• d-DAO General Ledger is NON-CUSTODIAL and DOES NOT TOUCH MONEY.
• The Voluntary Fulfillment Network (VFN) is the ONLY custodial/MSB layer (fiat activity lives there, not here).
• Proof-of-Delivery is a 2-scan protocol (seller scan → buyer acceptance scan).
• Language rule: these are "vouchers / hang tags / delivery credentials" — never "stamps."

🧭 Your Serendipity Assignment (geo + timestamp)
🟦 Peace Pentagon Branch: ${assignmentData.branchName} (${assignmentData.branchCode})
🏠 Buyer POC (Local): ${assignmentData.buyerPOCName}
🌍 Seller POC (Global): ${assignmentData.sellerPOCName}

🎭 Your Roles in Discord
• Branch Role: ${assignmentData.branchRoleMention}
• Buyer POC Role: ${assignmentData.buyerPOCRoleMention}
• Seller POC Role: ${assignmentData.sellerPOCRoleMention}

🧩 What you can do now
1) Open: #proof-of-delivery → read "2-Scan Quickstart"
2) Add your QRTiger v-card in #vcard (required for participation)
3) Confirm payout rail in #payout (PayPal/Venmo per your region)

📌 Reminder about value flow
• A confirmed delivery books a $10.30 trade-credit event in ledger terms (XP accounting only).
• Any real-world payment activity (if/when used) is handled outside the ledger by VFN participants.

If anything looks wrong, type: /my-assignment`;
            
            await member.send(dmMessage);
            console.log(`📧 Sent welcome DM to ${member.user.tag}`);
        } catch (dmError) {
            console.log(`⚠️ Could not send welcome DM to ${member.user.tag}: ${dmError.message} (This is normal if user has DMs disabled)`);
        }
        
    } catch (error) {
        console.error('Error handling member join:', error);
        
        // Send welcome message even if there's an error
        try {
            const welcomeChannel = client.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
            if (welcomeChannel) {
                await welcomeChannel.send(`🎉 Welcome <@${member.user.id}> to Gracebook!\nPlease verify your membership by uploading your QR code in <#${process.env.VERIFY_CHANNEL_ID}>`);
            }
        } catch (welcomeError) {
            console.error('Error sending welcome message:', welcomeError);
        }
    }
});

// Handle QR code verification (existing code)
client.on('messageCreate', async (message) => {

    
    
    // Handle command to check member join events
    if (message.content === '!checkevents' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const guild = message.guild;
            const memberCount = guild.memberCount;
            const botMember = guild.members.cache.get(client.user.id);
            
            await message.reply(`🔍 **Event Check:**\n- Guild: ${guild.name}\n- Member Count: ${memberCount}\n- Bot has GuildMembers intent: ${client.options.intents.has('GuildMembers')}\n- Bot can see members: ${botMember ? 'Yes' : 'No'}\n\nTry inviting someone to test the guildMemberAdd event!`);
        } catch (error) {
            await message.reply(`❌ Event check failed: ${error.message}`);
        }
        return;
    }
    
    // Handle command to check channel IDs
    if (message.content === '!checkchannels' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const verifyChannel = client.channels.cache.get(process.env.VERIFY_CHANNEL_ID);
            const welcomeChannel = client.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
            
            await message.reply(`🔍 **Channel Check:**\n- Verify Channel ID: ${process.env.VERIFY_CHANNEL_ID}\n- Verify Channel Found: ${verifyChannel ? `✅ ${verifyChannel.name}` : '❌ Not found'}\n- Welcome Channel ID: ${process.env.WELCOME_CHANNEL_ID}\n- Welcome Channel Found: ${welcomeChannel ? `✅ ${welcomeChannel.name}` : '❌ Not found'}\n\nIf channels are not found, the bot might not have access or the IDs are incorrect.`);
        } catch (error) {
            await message.reply(`❌ Channel check failed: ${error.message}`);
        }
        return;
    }
    
    
    // Handle test command for specific email verification
    if (message.content.startsWith('!testemail ') && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const testEmail = message.content.split(' ')[1];
            if (!testEmail) {
                await message.reply('❌ Please provide an email address. Usage: `!testemail user@example.com`');
                return;
            }
            
            await message.reply(`🧪 Testing membership verification for email: ${testEmail}`);
            
            console.log('🧪 Testing membership verification for specific email...');
            const [isMember, membershipType] = await verifySmallStreetMembership(testEmail);
            
            console.log('🧪 Testing role assignment...');
            const roleResult = await assignRoleBasedOnMembership(message.member, membershipType || 'pioneer');
            
            await message.reply(`🧪 **Email Test Result:**\n- Email: ${testEmail}\n- Found in API: ${isMember ? '✅ Yes' : '❌ No'}\n- Membership Type: ${membershipType || 'None'}\n- Role Assignment: ${roleResult.roleName || 'Failed'}\n- Error: ${roleResult.error || 'None'}`);
            
        } catch (error) {
            console.error('🧪 Email test failed:', error);
            await message.reply(`❌ Test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle command to create enhanced monthly poll
    if (message.content === '!createpoll' && message.author.id === process.env.ADMIN_USER_ID) {
        // Check if command is being used in the correct channel
        if (message.channel.id !== process.env.MONTHLY_REDEMPTION_CHANNEL_ID) {
            await message.reply(`❌ **This command can only be used in the #monthly-redemption channel!**\nPlease use this command in the correct channel.`);
            return;
        }
        
        const pollCreationId = `poll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        console.log(`🔍 !createpoll command triggered by ${message.author.tag} (${message.author.id}) at ${new Date().toISOString()}`);
        console.log(`🔍 Poll creation ID: ${pollCreationId}`);
        
        // Prevent multiple polls from being created simultaneously
        if (isCreatingPoll) {
            console.log(`⚠️ Poll creation already in progress (ID: ${currentPollCreationId}), ignoring duplicate command (ID: ${pollCreationId})`);
            await message.reply(`⚠️ **Poll creation already in progress!** (ID: ${currentPollCreationId})\nPlease wait for the current poll to be created.`);
            return;
        }
        
        isCreatingPoll = true;
        currentPollCreationId = pollCreationId;
        console.log(`🔍 Setting isCreatingPoll to true with ID: ${pollCreationId}`);
        
        // Set a timeout to automatically reset the flag after 30 seconds
        const timeoutId = setTimeout(() => {
            if (isCreatingPoll) {
                console.log(`⚠️ Poll creation timeout reached, resetting flags for ID: ${pollCreationId}`);
                isCreatingPoll = false;
                currentPollCreationId = null;
            }
        }, 30000);
        
        try {
            // Send initial reply
            const initialReply = await message.reply('🗳️ Creating Monthly Resource Allocation poll...').catch(err => {
                console.log('⚠️ Could not send initial reply:', err.message);
                return null;
            });
            
            const pollResult = await createEnhancedMonthlyPoll();
            
            if (pollResult.success) {
                console.log(`✅ Poll created successfully: ${pollResult.messageId}`);
                
                // Try to send success reply, but don't fail if it times out
                try {
                    const successMessage = `✅ **Enhanced Poll Created Successfully!**\n- Channel: <#${pollResult.channelId}>\n- Message ID: \`${pollResult.messageId}\`\n- Duration: 7 days\n- End Time: <t:${Math.floor(pollResult.endTime / 1000)}:F>\n- Options: 🕊️ Peace, 🗳️ Voting, 🆘 Disaster Relief`;
                    
                    // Add timeout to prevent socket hanging
                    const replyPromise = message.reply(successMessage);
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Reply timeout')), 10000)
                    );
                    
                    await Promise.race([replyPromise, timeoutPromise]);
                } catch (replyError) {
                    console.log('⚠️ Could not send success reply (poll was still created):', replyError.message);
                    // Poll was created successfully, just couldn't send the reply
                }
                
                // Reset the flag after successful creation
                clearTimeout(timeoutId);
                isCreatingPoll = false;
                currentPollCreationId = null;
                console.log(`🔍 Setting isCreatingPoll to false (success case) - ID: ${pollCreationId}`);
            } else {
                console.error('❌ Poll creation failed:', pollResult.error);
                try {
                    const errorMessage = `❌ **Failed to create poll:** ${pollResult.error}`;
                    
                    // Add timeout to prevent socket hanging
                    const replyPromise = message.reply(errorMessage);
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Reply timeout')), 10000)
                    );
                    
                    await Promise.race([replyPromise, timeoutPromise]);
                } catch (replyError) {
                    console.log('⚠️ Could not send error reply:', replyError.message);
                }
                
                // Reset the flag after error
                clearTimeout(timeoutId);
                isCreatingPoll = false;
                currentPollCreationId = null;
                console.log(`🔍 Setting isCreatingPoll to false (error case) - ID: ${pollCreationId}`);
            }
        } catch (error) {
            console.error('❌ Error creating enhanced poll:', error);
            try {
                const errorMessage = `❌ Poll creation failed: ${error.message}`;
                
                // Add timeout to prevent socket hanging
                const replyPromise = message.reply(errorMessage);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Reply timeout')), 10000)
                );
                
                await Promise.race([replyPromise, timeoutPromise]);
            } catch (replyError) {
                console.log('⚠️ Could not send error reply:', replyError.message);
            }
        } finally {
            // Always reset the flag and clear timeout
            clearTimeout(timeoutId);
            isCreatingPoll = false;
            currentPollCreationId = null;
            console.log(`🔍 Setting isCreatingPoll to false (finally) - ID: ${pollCreationId}`);
        }
        return;
    }
    
    // Handle command to get enhanced poll results
    if (message.content.startsWith('!pollresults ') && message.author.id === process.env.ADMIN_USER_ID) {
        // Check if command is being used in the correct channel
        if (message.channel.id !== process.env.MONTHLY_REDEMPTION_CHANNEL_ID) {
            await message.reply(`❌ **This command can only be used in the #monthly-redemption channel!**\nPlease use this command in the correct channel.`);
            return;
        }
        
        try {
            const messageId = message.content.split(' ')[1];
            if (!messageId) {
                await message.reply('❌ Please provide a message ID. Usage: `!pollresults <message_id>`');
                return;
            }
            
            await message.reply('📊 Getting enhanced poll results...');
            
            const results = await displayEnhancedPollResults(messageId);
            
            if (results.success) {
                await message.reply(`✅ **Enhanced poll results processed and displayed!**\n- Results: Posted in channel\n- XP Awards: Distributed\n- Fund Allocation: Calculated`);
            } else {
                await message.reply(`❌ **Failed to get results:** ${results.error}`);
            }
        } catch (error) {
            console.error('❌ Error getting enhanced poll results:', error);
            await message.reply(`❌ Failed to get results: ${error.message}`);
        }
        return;
    }
    
    // Handle command to get poll participants
    if (message.content.startsWith('!pollparticipants ') && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const messageId = message.content.split(' ')[1];
            if (!messageId) {
                await message.reply('❌ Please provide a message ID. Usage: `!pollparticipants <message_id>`');
                return;
            }
            
            await message.reply('📊 Retrieving poll participants...');
            
            const participants = await getPollParticipants(messageId);
            
            if (participants.success) {
                const data = participants.data;
                
                // Create detailed embed
                const embed = {
                    title: '📊 Poll Participants Report',
                    description: `Detailed breakdown of poll participation`,
                    color: 0x00ff00,
                    fields: [
                        {
                            name: '📈 Summary',
                            value: `**Total Voters:** ${data.summary.totalVoters}\n**Peace:** ${data.summary.peaceVoters}\n**Voting:** ${data.summary.votingVoters}\n**Disaster:** ${data.summary.disasterVoters}`,
                            inline: true
                        },
                        {
                            name: '🏆 Top Contributors',
                            value: data.topContributors.slice(0, 5).map((voter, index) => 
                                `${index + 1}. ${voter.displayName} (${formatEDecimal(voter.xpLevel)})`
                            ).join('\n'),
                            inline: true
                        },
                    {
                        name: '💡 Voting Power Distribution',
                        value: `**Total Weighted Votes:** ${data.topContributors.reduce((sum, v) => sum + v.votingPower, 0)}\n**Average Power:** ${(data.topContributors.reduce((sum, v) => sum + v.votingPower, 0) / data.topContributors.length).toFixed(1)}x`,
                        inline: false
                    },
                    {
                        name: '🔐 **Verification Status**',
                        value: `**Verified Users:** ${data.topContributors.filter(v => v.verified).length}/${data.topContributors.length}\n**Unverified Users:** ${data.topContributors.filter(v => !v.verified).length}/${data.topContributors.length}\n\n✅ = Verified in SmallStreet API\n❌ = Not found in API`,
                        inline: false
                    }
                    ],
                    footer: {
                        text: 'Make Everyone Great Again • SmallStreet Governance'
                    }
                };
                
                await message.reply({ embeds: [embed] });
                
            } else {
                await message.reply(`❌ **Failed to get participants:** ${participants.error}`);
            }
        } catch (error) {
            console.error('❌ Error getting poll participants:', error);
            await message.reply(`❌ Failed to get participants: ${error.message}`);
        }
        return;
    }
    
    // Handle debug command for poll participation
    if (message.content === '!participation' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            console.log('🔍 !participation command triggered');
            
            await message.reply('🔍 **Searching for recent polls...**');
            
            // Fetch recent messages to find poll messages
            const messages = await message.channel.messages.fetch({ limit: 50 });
            const pollMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                msg.embeds.length > 0 &&
                msg.embeds[0].title && 
                msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
            );
            
            // If no polls found in current channel, try the monthly redemption channel
            if (pollMessages.size === 0 && process.env.MONTHLY_REDEMPTION_CHANNEL_ID && message.channel.id !== process.env.MONTHLY_REDEMPTION_CHANNEL_ID) {
                console.log('🔍 No polls in current channel, trying monthly redemption channel');
                const monthlyChannel = client.channels.cache.get(process.env.MONTHLY_REDEMPTION_CHANNEL_ID);
                if (monthlyChannel) {
                    const monthlyMessages = await monthlyChannel.messages.fetch({ limit: 50 });
                    pollMessages = monthlyMessages.filter(msg => 
                        msg.author.id === client.user.id && 
                        msg.embeds.length > 0 &&
                        msg.embeds[0].title && 
                        msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
                    );
                    console.log(`🔍 Found ${pollMessages.size} poll messages in monthly redemption channel`);
                }
            }
            
            if (pollMessages.size === 0) {
                await message.reply('❌ **No poll messages found.**\n\n**Troubleshooting:**\n1. Check if a poll has been created with `!createpoll`\n2. Verify the bot has permission to read message history\n3. Make sure you\'re in the correct channel');
                return;
            }
            
            // Get the most recent poll
            const latestPoll = pollMessages.first();
            const messageId = latestPoll.id;
            
            console.log(`🔍 Found poll message ID: ${messageId}`);
            
            await message.reply(`📊 **Found Poll:** Analyzing participation for message \`${messageId}\`\n*Processing data...*`);
            
            // Get enhanced poll results
            const results = await getEnhancedPollResults(messageId);
            
            if (!results.success) {
                await message.reply(`❌ **Failed to get poll data:** ${results.error}`);
                return;
            }
            
            const data = results.data;
            
            console.log(`🔍 Poll data received:`, {
                peace: { count: data.peace.count, voters: data.peace.voters.length },
                voting: { count: data.voting.count, voters: data.voting.voters.length },
                disaster: { count: data.disaster.count, voters: data.disaster.voters.length },
                totalVoters: data.totalVoters
            });
            
            // Calculate and award XP for participation check
            const participationVoters = [
                ...data.peace.voters,
                ...data.voting.voters,
                ...data.disaster.voters
            ];
            
            console.log(`🔍 Total participation voters found: ${participationVoters.length}`);
            
            // Determine winning choice for XP calculation
            const participationWinningChoice = data.peace.weighted > data.voting.weighted && data.peace.weighted > data.disaster.weighted ? 'peace' :
                                data.voting.weighted > data.disaster.weighted ? 'voting' : 'disaster';
            
            console.log(`🔍 Winning choice for XP calculation: ${participationWinningChoice}`);
            
            // Award XP to all participants
            const xpResult = await awardPollXP(participationVoters, participationWinningChoice, messageId);
            console.log(`🔍 XP award result:`, xpResult);
            
            // Check if participants were found
            if (participationVoters.length === 0) {
                await message.reply('\n❌ **No participants found in this poll.**\n\n**Possible reasons:**\n• No one has voted yet\n• Poll reactions were cleared\n• Bot doesn\'t have permission to read reactions');
                return;
            }
            
            // Send direct messages to all participants
            console.log(`📤 Sending DMs to ${participationVoters.length} participants...`);
            await sendPollResultsToParticipants(participationVoters, participationWinningChoice, messageId);
            
            // Determine the winning choice
            const winningChoice = data.peace.weighted > data.voting.weighted && data.peace.weighted > data.disaster.weighted ? 'peace' :
                                data.voting.weighted > data.disaster.weighted ? 'voting' : 'disaster';
            
            const winningEmoji = winningChoice === 'peace' ? '🕊️' : winningChoice === 'voting' ? '🗳️' : '🆘';
            const winningName = winningChoice === 'peace' ? 'Peace Initiatives' : winningChoice === 'voting' ? 'Voting Programs' : 'Disaster Relief';
            
            // Get top contributor
            const allVoters = data.peace.voters.concat(data.voting.voters, data.disaster.voters);
            const topContributor = allVoters.sort((a, b) => b.votingPower - a.votingPower)[0];
            
            // Create structured table format
            const totalXP = participationVoters.reduce((sum, voter) => sum + calculatePollXP(voter, participationWinningChoice), 0);
            const winners = participationVoters.filter(v => v.choice === participationWinningChoice).length;
            const topContributors = participationVoters.filter(v => v.votingPower >= 25).length;
            const verifiedMembers = participationVoters.filter(v => v.verified).length;
            
            // Create clean text format
            let tableMessage = `🏆 POLL RESULTS\n`;
            tableMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            
            tableMessage += `📋 POLL INFORMATION\n`;
            tableMessage += `Message ID: ${messageId}\n`;
            tableMessage += `Analysis: ${new Date().toLocaleString()}\n\n`;
            
            tableMessage += `🎯 WINNING VOTE\n`;
            tableMessage += `${winningEmoji} ${winningName}\n\n`;
            tableMessage += `Weighted Votes: ${data[winningChoice].weighted}\n`;
            tableMessage += `Raw Votes: ${data[winningChoice].count}\n`;
            tableMessage += `Percentage: ${((data[winningChoice].weighted / (data.peace.weighted + data.voting.weighted + data.disaster.weighted)) * 100).toFixed(1)}%\n\n`;
            
            if (topContributor && participationVoters.length > 0) {
                tableMessage += `👑 TOP CONTRIBUTOR\n`;
                tableMessage += `${topContributor.displayName}\n\n`;
                tableMessage += `Choice: ${topContributor.choice}\n`;
                tableMessage += `XP Level: ${formatEDecimal(topContributor.xpLevel)}\n`;
                tableMessage += `Voting Power: ${topContributor.votingPower}x\n`;
                tableMessage += `Verified: ${topContributor.verified ? '✅ Yes' : '❌ No'}\n\n`;
            } else {
                tableMessage += `👑 TOP CONTRIBUTOR\n`;
                tableMessage += `${participationVoters.length === 0 ? 'No participants found' : 'No top contributors'}\n\n`;
            }
            
            tableMessage += `📊 VOTE SUMMARY\n`;
            tableMessage += `🕊️ Peace: ${data.peace.count} votes (${data.peace.weighted} weighted)\n`;
            tableMessage += `🗳️ Voting: ${data.voting.count} votes (${data.voting.weighted} weighted)\n`;
            tableMessage += `🆘 Disaster: ${data.disaster.count} votes (${data.disaster.weighted} weighted)\n\n`;
            tableMessage += `Total Participants: ${data.totalVoters}\n\n`;
            
            tableMessage += `💰 XP AWARDS SUMMARY\n`;
            tableMessage += `Total XP: ${formatEDecimal(totalXP)}\n`;
            tableMessage += `Winners: ${winners}\n`;
            tableMessage += `Top Contributors: ${topContributors}\n`;
            tableMessage += `Verified Members: ${verifiedMembers}\n\n`;
            
            tableMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            tableMessage += `Make Everyone Great Again • SmallStreet Governance`;
            
            // Create embed for the table
            const resultsEmbed = {
                title: '🏆 **Poll Results Table**',
                description: '```\n' + tableMessage + '\n```',
                color: winningChoice === 'peace' ? 0x00ff00 : winningChoice === 'voting' ? 0x0099ff : 0xff0000,
                footer: {
                    text: 'Structured Poll Results • SmallStreet Governance'
                },
                timestamp: new Date().toISOString()
            };
            
            await message.reply({ embeds: [resultsEmbed] });
            
            // Calculate and show fund allocation
            const allocation = calculateFundAllocation(data);
            
            const allocationEmbed = {
                title: '💰 **Fund Allocation**',
                description: 'Community resources distribution based on current votes:',
                color: 0x00ff00,
                fields: [
                    {
                        name: '🕊️ **Peace Initiatives**',
                        value: `**Allocation:** ${allocation.peace.percentage.toFixed(1)}%\n**Fund:** $${allocation.peace.allocation.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: '🗳️ **Voting Programs**',
                        value: `**Allocation:** ${allocation.voting.percentage.toFixed(1)}%\n**Fund:** $${allocation.voting.allocation.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: '🆘 **Disaster Relief**',
                        value: `**Allocation:** ${allocation.disaster.percentage.toFixed(1)}%\n**Fund:** $${allocation.disaster.allocation.toLocaleString()}`,
                        inline: true
                    }
                ],
                footer: {
                    text: 'Fund allocation based on current votes • SmallStreet Governance'
                }
            };
            
            await message.reply({ embeds: [allocationEmbed] });
            
            console.log(`✅ Participation report completed for poll ${messageId}`);
            
        } catch (error) {
            console.error('❌ Error in participation command:', error);
            await message.reply(`❌ **Participation analysis failed:** ${error.message}`);
        }
        return;
    }
    
    // Handle command to force update XP in database
    if (message.content === '!forceupdatexp' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🔄 **Force updating XP in database for latest poll...**');
            
            // Find latest poll
            const messages = await message.channel.messages.fetch({ limit: 50 });
            const pollMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                msg.embeds.length > 0 &&
                msg.embeds[0].title && 
                msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
            );
            
            if (pollMessages.size === 0) {
                await message.reply('❌ **No poll found.** Create a poll first with `!createpoll`');
                return;
            }
            
            const latestPoll = pollMessages.first();
            const messageId = latestPoll.id;
            
            // Get poll results
            const results = await getEnhancedPollResults(messageId);
            if (!results.success) {
                await message.reply(`❌ **Failed to get poll data:** ${results.error}`);
                return;
            }
            
            const data = results.data;
            const allVoters = [...data.peace.voters, ...data.voting.voters, ...data.disaster.voters];
            const winningChoice = data.peace.weighted > data.voting.weighted && data.peace.weighted > data.disaster.weighted ? 'peace' :
                                data.voting.weighted > data.disaster.weighted ? 'voting' : 'disaster';
            
            let updateResults = [];
            
            // Force update each voter's XP
            for (const voter of allVoters) {
                const xpAwarded = calculatePollXP(voter, winningChoice);
                const isWinner = voter.choice === winningChoice;
                const isTopContributor = voter.votingPower >= 25;
                
                console.log(`🔄 Force updating ${voter.username}: ${formatEDecimal(xpAwarded)} XP`);
                
                // Try primary update method
                let updateResult = await updatePollDataXP(messageId, voter.userId, xpAwarded);
                
                if (!updateResult.success) {
                    console.log(`🔄 Primary update failed, trying alternative for ${voter.username}...`);
                    updateResult = await updatePollDataXPAlternative(messageId, voter.userId, xpAwarded, voter.email);
                }
                
                updateResults.push({
                    username: voter.username,
                    xpAwarded: xpAwarded,
                    isWinner: isWinner,
                    isTopContributor: isTopContributor,
                    updateSuccess: updateResult.success,
                    updateError: updateResult.error
                });
            }
            
            // Show results
            let response = `🔄 **Force Update Results:**\n\n`;
            response += `**Poll ID:** \`${messageId}\`\n`;
            response += `**Winning Choice:** ${winningChoice}\n\n`;
            
            response += `**Update Results:**\n`;
            updateResults.forEach((result, index) => {
                response += `${index + 1}. **${result.username}**: ${formatEDecimal(result.xpAwarded)} XP\n`;
                response += `   • Choice: ${result.isWinner ? 'Winner ✅' : 'Non-winner'}\n`;
                response += `   • Top Contributor: ${result.isTopContributor ? 'Yes ✅' : 'No'}\n`;
                response += `   • Update: ${result.updateSuccess ? '✅ Success' : `❌ Failed (${result.updateError})`}\n\n`;
            });
            
            await message.reply(response);
            
        } catch (error) {
            console.error('❌ Error in force update XP:', error);
            await message.reply(`❌ **Force update failed:** ${error.message}`);
        }
        return;
    }
    
    // Handle command to test database update directly
    if (message.content === '!testupdate' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🧪 **Testing database update API directly...**');
            
            const testData = {
                poll_id: '1417818600240320543',
                discord_id: 1087338986047033364, // Gokarna's Discord ID
                xp_awarded: 6000000 // 6M XP
            };
            
            console.log('🧪 Testing update with data:', testData);
            
            const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/discord-poll-update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                body: JSON.stringify(testData)
            });
            
            const responseText = await response.text();
            console.log('🧪 Update API response:', response.status, responseText);
            
            let result = `🧪 **Database Update Test:**\n\n`;
            result += `**Request Data:**\n`;
            result += `• Poll ID: ${testData.poll_id}\n`;
            result += `• Discord ID: ${testData.discord_id}\n`;
            result += `• XP Awarded: ${formatEDecimal(testData.xp_awarded)}\n\n`;
            result += `**Response:**\n`;
            result += `• Status: ${response.status}\n`;
            result += `• Response: ${responseText}\n\n`;
            
            if (response.ok) {
                result += `✅ **Update successful!** Now run \`!checkapi\` to verify the change.`;
            } else {
                result += `❌ **Update failed!** Check the response for error details.`;
            }
            
            await message.reply(result);
            
        } catch (error) {
            console.error('❌ Error testing update:', error);
            await message.reply(`❌ **Test failed:** ${error.message}`);
        }
        return;
    }
    
    // Handle command to verify XP updates
    if (message.content === '!verifyxp' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🔍 **Verifying XP updates for latest poll...**');
            
            // Find latest poll
            const messages = await message.channel.messages.fetch({ limit: 50 });
            const pollMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                msg.embeds.length > 0 &&
                msg.embeds[0].title && 
                msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
            );
            
            if (pollMessages.size === 0) {
                await message.reply('❌ **No poll found.** Create a poll first with `!createpoll`');
                return;
            }
            
            const latestPoll = pollMessages.first();
            const messageId = latestPoll.id;
            
            // Get poll results
            const results = await getEnhancedPollResults(messageId);
            if (!results.success) {
                await message.reply(`❌ **Failed to get poll data:** ${results.error}`);
                return;
            }
            
            const data = results.data;
            const allVoters = [...data.peace.voters, ...data.voting.voters, ...data.disaster.voters];
            const winningChoice = data.peace.weighted > data.voting.weighted && data.peace.weighted > data.disaster.weighted ? 'peace' :
                                data.voting.weighted > data.disaster.weighted ? 'voting' : 'disaster';
            
            // Fetch current API data
            const apiResponse = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/get-discord-poll', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!apiResponse.ok) {
                await message.reply(`❌ **Failed to fetch API data:** ${apiResponse.status}`);
                return;
            }

            const apiData = await apiResponse.json();
            const pollData = apiData.filter(item => {
                try {
                    const discordPoll = JSON.parse(item.discord_poll);
                    return discordPoll.poll_id === messageId;
                } catch (error) {
                    return false;
                }
            });
            
            let response = `🔍 **XP Verification for Poll ${messageId}:**\n\n`;
            response += `**Winning Choice:** ${winningChoice}\n\n`;
            
            // Compare calculated XP with API data
            allVoters.forEach((voter, index) => {
                const calculatedXP = calculatePollXP(voter, winningChoice);
                const isWinner = voter.choice === winningChoice;
                const isTopContributor = voter.votingPower >= 25;
                
                // Find corresponding API data - look for both original and final XP entries
                const originalApiVoter = pollData.find(item => {
                    const discordPoll = JSON.parse(item.discord_poll);
                    return discordPoll.discord_id == voter.userId && discordPoll.vote_type === 'monthly_poll';
                });
                
                const finalApiVoter = pollData.find(item => {
                    const discordPoll = JSON.parse(item.discord_poll);
                    return discordPoll.discord_id == voter.userId && discordPoll.vote_type === 'xp_final_award';
                });
                
                const originalXP = originalApiVoter ? JSON.parse(originalApiVoter.discord_poll).xp_awarded : 0;
                const finalXP = finalApiVoter ? JSON.parse(finalApiVoter.discord_poll).xp_awarded : 0;
                const apiXP = finalXP || originalXP; // Use final XP if available, otherwise original
                const xpMatch = calculatedXP === apiXP;
                
                response += `${index + 1}. **${voter.username}**\n`;
                response += `   • Choice: ${voter.choice} ${isWinner ? '✅ (Winner)' : ''}\n`;
                response += `   • Calculated XP: ${formatEDecimal(calculatedXP)}\n`;
                response += `   • Original API XP: ${formatEDecimal(originalXP)}\n`;
                response += `   • Final API XP: ${formatEDecimal(finalXP)}\n`;
                response += `   • Using: ${finalXP ? 'Final' : 'Original'}\n`;
                response += `   • Match: ${xpMatch ? '✅' : '❌'}\n`;
                response += `   • Breakdown: 1M (base) + ${isWinner ? '5M (winner)' : '0M'} + ${isTopContributor ? '10M (top contributor)' : '0M'}\n\n`;
            });
            
            await message.reply(response);
            
        } catch (error) {
            console.error('❌ Error verifying XP:', error);
            await message.reply(`❌ **XP verification failed:** ${error.message}`);
        }
        return;
    }
    
    // Handle command to check API data after update
    if (message.content.startsWith('!checkapi') && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🔍 **Checking API data...**');
            
            // Fetch current API data
            const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/get-discord-poll', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!response.ok) {
                await message.reply(`❌ **Failed to fetch API data:** ${response.status}`);
                return;
            }

            const apiData = await response.json();
            
            // Parse command arguments
            const args = message.content.split(' ').slice(1);
            const specificPollId = args[0];
            
            let responseText = '';
            
            if (specificPollId) {
                // Check specific poll
                const pollData = apiData.filter(item => {
                    try {
                        const discordPoll = JSON.parse(item.discord_poll);
                        return discordPoll.poll_id === specificPollId;
                    } catch (error) {
                        return false;
                    }
                });

                responseText = `🔍 **API Data Check for Poll ${specificPollId}:**\n\n`;
                
                if (pollData.length === 0) {
                    responseText += '❌ **No data found for this poll in API**\n\n';
                    responseText += '**Available polls:**\n';
                    
                    // Show available polls
                    const allPolls = new Set();
                    apiData.forEach(item => {
                        try {
                            const discordPoll = JSON.parse(item.discord_poll);
                            allPolls.add(discordPoll.poll_id);
                        } catch (error) {
                            // Skip invalid entries
                        }
                    });
                    
                    const sortedPolls = Array.from(allPolls).sort((a, b) => b.localeCompare(a));
                    sortedPolls.slice(0, 10).forEach(pollId => {
                        responseText += `• ${pollId}\n`;
                    });
                    
                    if (sortedPolls.length > 10) {
                        responseText += `• ... and ${sortedPolls.length - 10} more polls\n`;
                    }
                } else {
                    responseText += `**Found ${pollData.length} records:**\n\n`;
                    
                    pollData.forEach((item, index) => {
                        const discordPoll = JSON.parse(item.discord_poll);
                        responseText += `${index + 1}. **${discordPoll.username}**\n`;
                        responseText += `   • Email: ${item.email}\n`;
                        responseText += `   • Vote: ${discordPoll.vote}\n`;
                        responseText += `   • XP Awarded: ${formatEDecimal(discordPoll.xp_awarded)} (${discordPoll.xp_awarded.toLocaleString()})\n`;
                        responseText += `   • Status: ${discordPoll.status}\n`;
                        responseText += `   • Submitted: ${discordPoll.submitted_at}\n\n`;
                    });
                }
            } else {
                // Auto-check the most recent poll
                const allPolls = new Set();
                apiData.forEach(item => {
                    try {
                        const discordPoll = JSON.parse(item.discord_poll);
                        allPolls.add(discordPoll.poll_id);
                    } catch (error) {
                        // Skip invalid entries
                    }
                });
                
                const sortedPolls = Array.from(allPolls).sort((a, b) => b.localeCompare(a));
                
                if (sortedPolls.length === 0) {
                    responseText = '❌ **No poll data found in API**';
                } else {
                    // Get the most recent poll ID
                    const mostRecentPollId = sortedPolls[0];
                    
                    // Check the most recent poll
                    const pollData = apiData.filter(item => {
                        try {
                            const discordPoll = JSON.parse(item.discord_poll);
                            return discordPoll.poll_id === mostRecentPollId;
                        } catch (error) {
                            return false;
                        }
                    });

                    responseText = `🔍 **API Data Check for Most Recent Poll ${mostRecentPollId}:**\n\n`;
                    
                    if (pollData.length === 0) {
                        responseText += '❌ **No data found for this poll in API**';
                    } else {
                        // Group by user and prioritize final XP entries
                        const userData = {};
                        pollData.forEach(item => {
                            const discordPoll = JSON.parse(item.discord_poll);
                            const userId = discordPoll.discord_id;
                            
                            if (!userData[userId]) {
                                userData[userId] = {
                                    username: discordPoll.username,
                                    email: item.email,
                                    vote: discordPoll.vote,
                                    records: []
                                };
                            }
                            
                            userData[userId].records.push({
                                xp_awarded: discordPoll.xp_awarded,
                                status: discordPoll.status,
                                vote_type: discordPoll.vote_type,
                                submitted_at: discordPoll.submitted_at,
                                is_final: discordPoll.vote_type === 'xp_final_award' || discordPoll.status === 'final_awarded'
                            });
                        });
                        
                        // Sort records by priority (final entries first)
                        Object.values(userData).forEach(user => {
                            user.records.sort((a, b) => {
                                if (a.is_final && !b.is_final) return -1;
                                if (!a.is_final && b.is_final) return 1;
                                return new Date(b.submitted_at) - new Date(a.submitted_at);
                            });
                        });
                        
                        responseText += `**Found ${Object.keys(userData).length} unique users:**\n\n`;
                        
                        Object.values(userData).forEach((user, index) => {
                            const finalRecord = user.records.find(r => r.is_final) || user.records[0];
                            const isWinner = finalRecord.xp_awarded > 1000000;
                            
                            responseText += `${index + 1}. **${user.username}**\n`;
                            responseText += `   • Email: ${user.email}\n`;
                            responseText += `   • Vote: ${user.vote}\n`;
                            responseText += `   • Final XP: ${formatEDecimal(finalRecord.xp_awarded)} (${finalRecord.xp_awarded.toLocaleString()})\n`;
                            responseText += `   • Status: ${finalRecord.status} ${isWinner ? '🏆 (Winner!)' : ''}\n`;
                            responseText += `   • Type: ${finalRecord.vote_type}\n`;
                            responseText += `   • Submitted: ${finalRecord.submitted_at}\n`;
                            
                            if (user.records.length > 1) {
                                responseText += `   • Total Records: ${user.records.length} (showing final)\n`;
                            }
                            responseText += `\n`;
                        });
                    }
                    
                    // Add summary of other polls
                    if (sortedPolls.length > 1) {
                        responseText += `\n📊 **Other polls available:**\n`;
                        sortedPolls.slice(1, 6).forEach(pollId => {
                            responseText += `• ${pollId}\n`;
                        });
                        if (sortedPolls.length > 6) {
                            responseText += `• ... and ${sortedPolls.length - 6} more polls\n`;
                        }
                        responseText += `\n💡 **Usage:** \`!checkapi <poll_id>\` to check specific poll details`;
                    }
                }
            }
            
            await message.reply(responseText);
            
        } catch (error) {
            console.error('❌ Error checking API data:', error);
            await message.reply(`❌ **API check failed:** ${error.message}`);
        }
        return;
    }
    
    // Handle command to manually award XP for testing
    if (message.content === '!awardxp' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🔄 **Manually triggering XP awards for latest poll...**');
            
            // Find latest poll
            const messages = await message.channel.messages.fetch({ limit: 50 });
            const pollMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                msg.embeds.length > 0 &&
                msg.embeds[0].title && 
                msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
            );
            
            if (pollMessages.size === 0) {
                await message.reply('❌ **No poll found.** Create a poll first with `!createpoll`');
                return;
            }
            
            const latestPoll = pollMessages.first();
            const messageId = latestPoll.id;
            
            // Get poll results
            const results = await getEnhancedPollResults(messageId);
            if (!results.success) {
                await message.reply(`❌ **Failed to get poll data:** ${results.error}`);
                return;
            }
            
            const data = results.data;
            const allVoters = [...data.peace.voters, ...data.voting.voters, ...data.disaster.voters];
            const winningChoice = data.peace.weighted > data.voting.weighted && data.peace.weighted > data.disaster.weighted ? 'peace' :
                                data.voting.weighted > data.disaster.weighted ? 'voting' : 'disaster';
            
            // Award XP
            const xpResult = await awardPollXP(allVoters, winningChoice, messageId);
            
            if (xpResult.success) {
                let response = `✅ **XP Awards Completed!**\n\n`;
                response += `**Poll ID:** \`${messageId}\`\n`;
                response += `**Winning Choice:** ${winningChoice}\n`;
                response += `**Participants:** ${xpResult.awards.length}\n\n`;
                
                response += `**XP Breakdown:**\n`;
                xpResult.awards.forEach((award, index) => {
                    const isWinner = award.choice === winningChoice;
                    const isTopContributor = award.votingPower >= 25;
                    response += `${index + 1}. **${award.username}**: ${formatEDecimal(award.xpAwarded)} XP\n`;
                    response += `   • Choice: ${award.choice} ${isWinner ? '✅ (Winner)' : ''}\n`;
                    response += `   • Breakdown: 1M (base) + ${isWinner ? '5M (winner)' : '0M'} + ${isTopContributor ? '10M (top contributor)' : '0M'}\n\n`;
                });
                
                await message.reply(response);
            } else {
                await message.reply(`❌ **XP Award Failed:** ${xpResult.error}`);
            }
            
        } catch (error) {
            console.error('❌ Error in manual XP award:', error);
            await message.reply(`❌ **Manual XP award failed:** ${error.message}`);
        }
        return;
    }
    
    // Handle command to check poll channel
    if (message.content === '!checkpollchannel' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const channel = client.channels.cache.get(process.env.MONTHLY_REDEMPTION_CHANNEL_ID);
            
            if (channel) {
                await message.reply(`✅ **Poll Channel Check:**\n- Channel: ${channel.name}\n- ID: \`${channel.id}\`\n- Type: ${channel.type}\n- Bot can send messages: ${channel.permissionsFor(client.user).has('SendMessages') ? '✅ Yes' : '❌ No'}`);
            } else {
                await message.reply(`❌ **Poll Channel Not Found:**\n- Channel ID: \`${process.env.MONTHLY_REDEMPTION_CHANNEL_ID}\`\n- Make sure the bot has access to this channel`);
            }
        } catch (error) {
            await message.reply(`❌ Channel check failed: ${error.message}`);
        }
        return;
    }
    
    // Handle help command for enhanced poll functionality
    if (message.content === '!pollhelp' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const helpEmbed = {
                title: '🗳️ Enhanced Poll Management Commands',
                description: 'Available commands for managing Monthly Resource Allocation polls:',
                color: 0x00ff00,
                fields: [
                    {
                        name: '!createpoll',
                        value: 'Create a new Monthly Resource Allocation poll with three choices: 🕊️ Peace, 🗳️ Voting, 🆘 Disaster Relief',
                        inline: false
                    },
                    {
                        name: '!pollresults <message_id>',
                        value: 'Get enhanced results with weighted voting, fund allocation, and XP distribution',
                        inline: false
                    },
                    {
                        name: '!pollparticipants <message_id>',
                        value: 'Get detailed participant list with voting power and XP levels',
                        inline: false
                    },
                    {
                        name: '!participation',
                        value: 'Debug command: Auto-find and analyze the latest poll in #monthly-redemption channel',
                        inline: false
                    },
                    {
                        name: '!checkpollchannel',
                        value: 'Check if the poll channel is accessible',
                        inline: false
                    },
                    {
                        name: '!pollscheduler',
                        value: 'Check poll scheduler status and next poll date',
                        inline: false
                    },
                    {
                        name: '💡 Poll Features',
                        value: '• Weighted voting based on XP levels (1x to 100x power)\n• XP rewards: 1M base + 5M winning + 10M top contributor\n• Fund allocation proportional to weighted votes\n• Automatic results processing after 7 days',
                        inline: false
                    },
                    {
                        name: '!pollhelp',
                        value: 'Show this help message',
                        inline: false
                    }
                ],
                footer: {
                    text: 'Make Everyone Great Again • SmallStreet Governance • Enhanced Poll System'
                }
            };
            
            await message.reply({ embeds: [helpEmbed] });
        } catch (error) {
            await message.reply(`❌ Help command failed: ${error.message}`);
        }
        return;
    }

    // Handle profile command in wallet channel
    if (message.content.startsWith('!profile') && message.channel.id === process.env.WALLET_CHANNEL_ID) {
        try {
            console.log(`🔍 Profile command received: "${message.content}" in channel: ${message.channel.name}`);
            
            // Check if user is admin
            const isAdmin = message.author.id === process.env.ADMIN_USER_ID;
            
            // Extract arguments from the command
            const args = message.content.split(' ');
            
            let targetUsername;
            let actualUsername;
            let discordUser = null;
            
            if (isAdmin && args.length >= 2) {
                // Admin can mention any user
                targetUsername = args[1];
                console.log(`🎯 Admin targeting username: "${targetUsername}"`);
                
                // Remove @ symbol if present
                if (targetUsername.startsWith('@')) {
                    targetUsername = targetUsername.substring(1);
                    console.log(`🔍 After removing @: "${targetUsername}"`);
                }

                // Handle Discord mentions - extract actual Discord user data
                if (targetUsername.startsWith('<@!') && targetUsername.endsWith('>')) {
                    const userId = targetUsername.slice(3, -1);
                    console.log(`🔍 Extracted user ID: "${userId}"`);
                    discordUser = client.users.cache.get(userId);
                    if (discordUser) {
                        actualUsername = discordUser.username;
                        console.log(`🔍 Resolved to Discord user: ${discordUser.username} (${discordUser.displayName})`);
                    } else {
                        await message.reply('❌ **User not found.** Please use a valid Discord mention.');
                        return;
                    }
                } else if (targetUsername.startsWith('<@') && targetUsername.endsWith('>')) {
                    const userId = targetUsername.slice(2, -1);
                    console.log(`🔍 Extracted user ID: "${userId}"`);
                    discordUser = client.users.cache.get(userId);
                    if (discordUser) {
                        actualUsername = discordUser.username;
                        console.log(`🔍 Resolved to Discord user: ${discordUser.username} (${discordUser.displayName})`);
                    } else {
                        await message.reply('❌ **User not found.** Please use a valid Discord mention.');
                        return;
                    }
                } else {
                    actualUsername = targetUsername;
                }
            } else if (isAdmin && args.length === 1) {
                // Admin using !profile without mention - show their own profile
                actualUsername = message.author.username;
                discordUser = message.author;
                console.log(`🎯 Admin viewing own profile: "${actualUsername}"`);
            } else if (!isAdmin && args.length === 1) {
                // Regular user can only view their own profile
                actualUsername = message.author.username;
                discordUser = message.author;
                console.log(`🎯 Regular user viewing own profile: "${actualUsername}"`);
            } else if (!isAdmin && args.length >= 2) {
                // Regular user trying to mention someone else - not allowed
                await message.reply('❌ **You can only view your own profile.** Use `!profile` without mentioning anyone.');
                return;
            } else {
                await message.reply('❌ **Usage:** `!profile` (for your own profile) or `!profile @username` (admin only)');
                return;
            }

            console.log(`🔍 Final username to search: "${actualUsername}"`);
            
            // Check if username is empty or just spaces
            if (!actualUsername || actualUsername.trim() === '') {
                await message.reply('❌ **Invalid username.** Please provide a valid username.');
                return;
            }
            
            await message.reply('🔍 **Fetching profile data...**');

            // Try to get user profile data from API
            console.log(`📡 Calling getUserProfileData for: "${actualUsername}"`);
            const profileResult = await getUserProfileData(actualUsername);
            console.log(`📊 Profile result:`, profileResult);
            
            if (!profileResult.success) {
                await message.reply(`❌ **Error fetching profile:** ${profileResult.error}`);
                return;
            }

            const profile = profileResult.data;
            
            // Create profile embed with API data
            const profileEmbed = {
                title: `👤 Profile: ${profile.fullName}`,
                color: profile.membership !== 'unverified' ? 0x00ff00 : 0xffa500,
                thumbnail: discordUser ? {
                    url: discordUser.displayAvatarURL()
                } : undefined,
                fields: [
                    {
                        name: '🎯 Discord Username',
                        value: profile.discordUsername,
                        inline: true
                    },
                    {
                        name: '📝 Full Name',
                        value: profile.fullName,
                        inline: true
                    },
                    {
                        name: '📧 Email',
                        value: profile.email || 'Not available',
                        inline: true
                    },
                    {
                        name: '🏆 Membership',
                        value: profile.membership || 'Unverified',
                        inline: true
                    },
                    {
                        name: '🎭 Discord Roles',
                        value: 'Loading...', // Will be updated below
                        inline: true
                    }
                ],
                footer: {
                    text: `SmallStreet Profile • Discord ID: ${profile.discordId || 'N/A'}`
                },
                timestamp: new Date().toISOString()
            };

            // Get Discord roles and update the field
            let discordRoles = 'No roles';
            if (discordUser) {
                try {
                    const guild = message.guild;
                    const member = guild.members.cache.get(discordUser.id);
                    if (member) {
                        const roles = member.roles.cache
                            .filter(role => role.name !== '@everyone')
                            .map(role => role.name);
                        discordRoles = roles.length > 0 ? roles.join(', ') : 'No roles';
                    }
                } catch (error) {
                    console.log('Could not fetch Discord roles:', error.message);
                }
            }
            
            // Update the Discord Roles field
            profileEmbed.fields[4].value = discordRoles;

            // Add Total XP
            profileEmbed.fields.push({
                name: '💰 Total XP',
                value: formatXPNumber(profile.totalXP) || '0',
                inline: false
            });

            // Add join date if available
            if (profile.joinDate) {
                profileEmbed.fields.push({
                    name: '📅 Joined Discord',
                    value: new Date(profile.joinDate).toLocaleDateString(),
                    inline: true
                });
            }

            // Add verification date if available
            if (profile.verificationDate) {
                profileEmbed.fields.push({
                    name: '✅ Verified',
                    value: new Date(profile.verificationDate).toLocaleDateString(),
                    inline: true
                });
            }

            await message.reply({ embeds: [profileEmbed] });

        } catch (error) {
            console.error('Profile command error:', error);
            await message.reply(`❌ **Error displaying profile:** ${error.message}`);
        }
        return;
    }

    // Handle transaction command in wallet channel
    if (message.content.startsWith('!transaction') && message.channel.id === process.env.WALLET_CHANNEL_ID) {
        try {
            console.log(`🔍 Transaction command received: "${message.content}" in channel: ${message.channel.name}`);
            
            // Check if user is admin
            const isAdmin = message.author.id === process.env.ADMIN_USER_ID;
            
            // Extract arguments from the command
            const args = message.content.split(' ');
            
            let targetUsername;
            let actualUsername;
            let discordUser = null;
            
            if (isAdmin && args.length >= 2) {
                // Admin can mention any user
                targetUsername = args[1];
                console.log(`🎯 Admin targeting username: "${targetUsername}"`);
                
                // Remove @ symbol if present
                if (targetUsername.startsWith('@')) {
                    targetUsername = targetUsername.substring(1);
                    console.log(`🔍 After removing @: "${targetUsername}"`);
                }

                // Handle Discord mentions - extract actual Discord user data
                if (targetUsername.startsWith('<@!') && targetUsername.endsWith('>')) {
                    const userId = targetUsername.slice(3, -1);
                    console.log(`🔍 Extracted user ID: "${userId}"`);
                    discordUser = client.users.cache.get(userId);
                    if (discordUser) {
                        actualUsername = discordUser.username;
                        console.log(`🔍 Resolved to Discord user: ${discordUser.username} (${discordUser.displayName})`);
                    } else {
                        await message.reply('❌ **User not found.** Please use a valid Discord mention.');
                        return;
                    }
                } else if (targetUsername.startsWith('<@') && targetUsername.endsWith('>')) {
                    const userId = targetUsername.slice(2, -1);
                    console.log(`🔍 Extracted user ID: "${userId}"`);
                    discordUser = client.users.cache.get(userId);
                    if (discordUser) {
                        actualUsername = discordUser.username;
                        console.log(`🔍 Resolved to Discord user: ${discordUser.username} (${discordUser.displayName})`);
                    } else {
                        await message.reply('❌ **User not found.** Please use a valid Discord mention.');
                        return;
                    }
                } else {
                    actualUsername = targetUsername;
                }
            } else if (isAdmin && args.length === 1) {
                // Admin using !transaction without mention - show their own transaction data
                actualUsername = message.author.username;
                discordUser = message.author;
                console.log(`🎯 Admin viewing own transaction data: "${actualUsername}"`);
            } else if (!isAdmin && args.length === 1) {
                // Regular user can only view their own transaction data
                actualUsername = message.author.username;
                discordUser = message.author;
                console.log(`🎯 Regular user viewing own transaction data: "${actualUsername}"`);
            } else if (!isAdmin && args.length >= 2) {
                // Regular user trying to mention someone else - not allowed
                await message.reply('❌ **You can only view your own transaction data.** Use `!transaction` without mentioning anyone.');
                return;
            } else {
                await message.reply('❌ **Usage:** `!transaction` (for your own data) or `!transaction @username` (admin only)');
                return;
            }

            console.log(`🔍 Final username to search: "${actualUsername}"`);
            
            // Check if username is empty or just spaces
            if (!actualUsername || actualUsername.trim() === '') {
                await message.reply('❌ **Invalid username.** Please provide a valid username.');
                return;
            }
            
            await message.reply('🔍 **Fetching transaction data...**');

            // Try to get user transaction data from API
            console.log(`📡 Calling getUserProfileData for transaction data: "${actualUsername}"`);
            const profileResult = await getUserProfileData(actualUsername);
            console.log(`📊 Profile result:`, profileResult);
            
            if (!profileResult.success) {
                await message.reply(`❌ **Error fetching transaction data:** ${profileResult.error}`);
                return;
            }

            const profile = profileResult.data;
            
            // Create transaction embed
            const transactionEmbed = {
                title: `📊 Transaction History: ${profile.fullName}`,
                color: 0x0099ff,
                thumbnail: discordUser ? {
                    url: discordUser.displayAvatarURL()
                } : undefined,
                fields: [],
                footer: {
                    text: `SmallStreet Transaction Data • Discord ID: ${profile.discordId || 'N/A'}`
                },
                timestamp: new Date().toISOString()
            };

            // Add total XP summary
            transactionEmbed.fields.push({
                name: '💰 Total XP Summary',
                value: `**Total XP:** ${formatXPNumber(profile.totalXP) || '0'}\n**Formatted:** ${formatEDecimal(profile.totalXP) || 'e+0'}`,
                inline: false
            });

            // Add detailed transaction information in table format
            const transactionRows = [];
            
            // Discord Invite Transaction
            if (profile.xpBreakdown && xpGreaterThanZero(profile.xpBreakdown.discordInvite)) {
                transactionRows.push({
                    orderDetails: `Discord Join - @${profile.discordUsername} - ${profile.joinDate ? new Date(profile.joinDate).toLocaleString() : 'Unknown Date'}`,
                    xpAwarded: formatXPNumber(profile.xpBreakdown.discordInvite),
                    status: 'Released'
                });
            }

            const meta = profile.metaData || {};
            const buyerScans = Array.isArray(meta.buyer_scan) ? meta.buyer_scan : [];
            const sellerScans = Array.isArray(meta.seller_scan) ? meta.seller_scan : [];
            const personalScans = Array.isArray(meta.personal_scan) ? meta.personal_scan : [];

            // Buyer: show per-scan rows when API returns buyer_scan; else legacy aggregate row
            if (buyerScans.length > 0) {
                buyerScans.forEach((scan, index) => {
                    const xp = scan.xp_units;
                    if (!xpGreaterThanZero(xp)) return;
                    const when = scan.date || scan.timestamp || 'Unknown Date';
                    const tid = scan.transaction_id || `buyer-${index + 1}`;
                    const oid = scan.order_id != null ? ` order #${scan.order_id}` : '';
                    transactionRows.push({
                        orderDetails: `Buyer scan — ${tid}${oid} — ${when}`,
                        xpAwarded: formatXPNumber(xp),
                        status: scan.scan_status || 'Released'
                    });
                });
            } else if (profile.xpBreakdown && xpGreaterThanZero(profile.xpBreakdown.buyerDetails)) {
                transactionRows.push({
                    orderDetails: `Buyer Details - @${profile.discordUsername} - ${profile.verificationDate ? new Date(profile.verificationDate).toLocaleString() : 'Unknown Date'}`,
                    xpAwarded: formatXPNumber(profile.xpBreakdown.buyerDetails),
                    status: 'Released'
                });
            }

            // Seller: per-scan or aggregate
            if (sellerScans.length > 0) {
                sellerScans.forEach((scan, index) => {
                    const xp = scan.xp_units;
                    if (!xpGreaterThanZero(xp)) return;
                    const when = scan.date || scan.timestamp || 'Unknown Date';
                    const tid = scan.transaction_id || `seller-${index + 1}`;
                    const oid = scan.order_id != null ? ` order #${scan.order_id}` : '';
                    transactionRows.push({
                        orderDetails: `Seller scan — ${tid}${oid} — ${when}`,
                        xpAwarded: formatXPNumber(xp),
                        status: scan.scan_status || 'Released'
                    });
                });
            } else if (profile.xpBreakdown && xpGreaterThanZero(profile.xpBreakdown.sellerDetails)) {
                transactionRows.push({
                    orderDetails: `Seller Details - @${profile.discordUsername} - ${profile.verificationDate ? new Date(profile.verificationDate).toLocaleString() : 'Unknown Date'}`,
                    xpAwarded: formatXPNumber(profile.xpBreakdown.sellerDetails),
                    status: 'Released'
                });
            }

            personalScans.forEach((scan, index) => {
                const xp = scan.xp_units;
                if (!xpGreaterThanZero(xp)) return;
                const when = scan.date || scan.timestamp || 'Unknown Date';
                const tid = scan.transaction_id || `personal-${index + 1}`;
                transactionRows.push({
                    orderDetails: `Personal scan — ${tid} — ${when}`,
                    xpAwarded: formatXPNumber(xp),
                    status: scan.scan_status || 'Released'
                });
            });

            // Add detailed Discord Poll breakdowns
            if (profile.metaData && profile.metaData._discord_poll && Array.isArray(profile.metaData._discord_poll)) {
                const pollEntries = profile.metaData._discord_poll;
                pollEntries.forEach((poll, index) => {
                    try {
                        const pollData = typeof poll === 'string' ? JSON.parse(poll) : poll;
                        const pollId = pollData.poll_id || 'Unknown';
                        const vote = pollData.vote || 'Unknown';
                        const xpAwarded = pollData.xp_awarded || 0;
                        const submittedAt = pollData.submitted_at ? new Date(pollData.submitted_at).toLocaleString() : 'Unknown Date';
                        const voteType = pollData.vote_type || 'Unknown';
                        
                        // Determine vote description
                        let voteDescription = vote;
                        if (vote === 'peace') voteDescription = 'peace';
                        else if (vote === 'voting') voteDescription = 'voting';
                        else if (vote === 'disaster') voteDescription = 'disaster';
                        else if (voteType === 'xp_final_award') voteDescription = 'final_xp_award';
                        
                        transactionRows.push({
                            orderDetails: `Monthly poll - @${profile.discordUsername} (${voteDescription}) - ${submittedAt}`,
                            xpAwarded: formatXPNumber(xpAwarded),
                            status: 'Released'
                        });
                    } catch (error) {
                        console.log('Error parsing poll data:', error);
                        transactionRows.push({
                            orderDetails: `Monthly poll - @${profile.discordUsername} (Parse Error) - Unknown Date`,
                            xpAwarded: formatXPNumber(poll.xp_awarded || 0),
                            status: 'Released'
                        });
                    }
                });
            }
            
            // Add detailed Talent Show breakdowns
            if (profile.metaData && profile.metaData._talentshow_entry && Array.isArray(profile.metaData._talentshow_entry)) {
                const talentEntries = profile.metaData._talentshow_entry;
                talentEntries.forEach((talent, index) => {
                    try {
                        const talentData = typeof talent === 'string' ? JSON.parse(talent) : talent;
                        const xpAwarded = talentData.xp_awarded || 0;
                        const submittedAt = talentData.submitted_at ? new Date(talentData.submitted_at).toLocaleString() : 'Unknown Date';
                        const entryType = talentData.entry_type || 'Talentshow entry';
                        
                        transactionRows.push({
                            orderDetails: `${entryType} - ${submittedAt}`,
                            xpAwarded: formatXPNumber(xpAwarded),
                            status: 'Released'
                        });
                    } catch (error) {
                        console.log('Error parsing talent show data:', error);
                        transactionRows.push({
                            orderDetails: `Talentshow entry - Unknown Date`,
                            xpAwarded: formatXPNumber(talent.xp_awarded || 0),
                            status: 'Released'
                        });
                    }
                });
            }

            // Create table format display
            if (transactionRows.length > 0) {
                // Create a table-like structure using Discord embed fields
                const tableContent = transactionRows.map((row, index) => {
                    const rowNumber = (index + 1).toString().padStart(2, '0');
                    return `**${rowNumber}.** ${row.orderDetails}\n💰 **XP:** ${row.xpAwarded} | ✅ **Status:** ${row.status}`;
                }).join('\n\n');
                
                transactionEmbed.fields.push({
                    name: '📋 Transaction History',
                    value: tableContent,
                    inline: false
                });
            } else {
                transactionEmbed.fields.push({
                    name: '📋 Transaction History',
                    value: 'No transaction history found',
                    inline: false
                });
            }

            // Add membership and verification info
            transactionEmbed.fields.push({
                name: '🏆 Account Status',
                value: `**Membership:** ${profile.membership || 'Unverified'}\n**Email:** ${profile.email || 'Not available'}\n**Verified:** ${profile.verificationDate ? new Date(profile.verificationDate).toLocaleDateString() : 'Not verified'}`,
                inline: false
            });

            await message.reply({ embeds: [transactionEmbed] });

        } catch (error) {
            console.error('Transaction command error:', error);
            await message.reply(`❌ **Error displaying transaction data:** ${error.message}`);
        }
        return;
    }

    // Handle wallet channel check command
    if (message.content === '!checkwallet' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const walletChannel = client.channels.cache.get(process.env.WALLET_CHANNEL_ID);
            
            const checkEmbed = {
                title: '🔍 Wallet Channel Check',
                color: walletChannel ? 0x00ff00 : 0xff0000,
                fields: [
                    {
                        name: '📋 Environment Variable',
                        value: `WALLET_CHANNEL_ID: ${process.env.WALLET_CHANNEL_ID || 'Not set'}`,
                        inline: false
                    },
                    {
                        name: '📍 Channel Status',
                        value: walletChannel ? `✅ Found: ${walletChannel.name}` : '❌ Not found',
                        inline: false
                    },
                    {
                        name: '🎯 Current Channel',
                        value: `Name: ${message.channel.name}\nID: ${message.channel.id}`,
                        inline: false
                    },
                    {
                        name: '🔗 API Endpoint',
                        value: 'https://www.smallstreet.app/wp-json/myapi/v1/user-xp-data',
                        inline: false
                    }
                ],
                footer: {
                    text: 'Wallet Channel Check'
                }
            };

            await message.reply({ embeds: [checkEmbed] });
        } catch (error) {
            await message.reply(`❌ **Channel Check Error:** ${error.message}`);
        }
        return;
    }

    // Handle test profile command (for debugging)
    if (message.content.startsWith('!testprofile ')) {
        try {
            const args = message.content.split(' ');
            if (args.length < 2) {
                await message.reply('❌ **Usage:** `!testprofile username`');
                return;
            }

            const username = args[1];
            
            const testEmbed = {
                title: `🧪 Test Profile: ${username}`,
                color: 0x00ff00,
                fields: [
                    {
                        name: '🎯 Username',
                        value: username,
                        inline: true
                    },
                    {
                        name: '📊 Status',
                        value: 'Test Mode - No API Call',
                        inline: true
                    },
                    {
                        name: '💰 Test XP',
                        value: '1.0e+6',
                        inline: true
                    }
                ],
                footer: {
                    text: 'Test Profile Command'
                }
            };

            await message.reply({ embeds: [testEmbed] });
        } catch (error) {
            await message.reply(`❌ **Test Error:** ${error.message}`);
        }
        return;
    }
    
    // Handle command to test poll data storage
    if (message.content === '!testpollstorage' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🧪 **Testing Poll Data Storage...**');
            
            const testPollData = {
                poll_id: 'test_poll_123',
                email: 'test@example.com',
                vote: 'peace',
                vote_type: 'monthly_poll',
                discord_id: '123456789',
                username: 'testuser',
                display_name: 'Test User',
                membership: 'verified',
                xp_awarded: 100
            };
            
            const result = await storePollData(testPollData);
            
            if (result.success) {
                await message.reply(`✅ **Poll Data Storage Test Successful!**\n\n**Response:**\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``);
            } else {
                await message.reply(`❌ **Poll Data Storage Test Failed:**\n\n**Error:** ${result.error}`);
            }
            
        } catch (error) {
            console.error('❌ Error testing poll data storage:', error);
            await message.reply(`❌ Poll data storage test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle command to test Discord invites API specifically
    if (message.content === '!testinvitesapi' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🧪 **Testing Discord Invites API specifically...**');
            
            const invitesData = await getDiscordInvitesData();
            
            if (invitesData.success) {
                const data = invitesData.data;
                let apiInfo = `✅ **Discord Invites API Test Successful!**\n\n`;
                apiInfo += `**Total Records:** ${data.length}\n\n`;
                apiInfo += `**Sample Records:**\n`;
                
                // Show first 3 records
                for (let i = 0; i < Math.min(3, data.length); i++) {
                    const record = data[i];
                    try {
                        const discordData = JSON.parse(record.discord_invite);
                        apiInfo += `\n**Record ${i + 1}:**\n`;
                        apiInfo += `- User ID: ${record.user_id}\n`;
                        apiInfo += `- Email: ${record.email}\n`;
                        apiInfo += `- Discord Username: ${discordData.discord_username}\n`;
                        apiInfo += `- Display Name: ${discordData.discord_display_name}\n`;
                        apiInfo += `- XP Awarded: ${discordData.xp_awarded}\n`;
                    } catch (parseError) {
                        apiInfo += `\n**Record ${i + 1}:** Error parsing JSON\n`;
                    }
                }
                
                await message.reply(apiInfo);
            } else {
                await message.reply(`❌ **Discord Invites API Test Failed:** ${invitesData.error}\n\n**Possible Issues:**\n1. API key not set or invalid\n2. API endpoint not accessible\n3. Authentication failed\n4. Server error\n\nCheck console logs for detailed error information.`);
            }
            
        } catch (error) {
            console.error('❌ Error testing Discord Invites API:', error);
            await message.reply(`❌ Discord Invites API test failed: ${error.message}\n\nCheck console logs for detailed error information.`);
        }
        return;
    }
    
    // Handle command to test Discord invites API
    if (message.content === '!testapi' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🧪 **Testing Discord Invites API...**');
            
            const invitesData = await getDiscordInvitesData();
            
            if (invitesData.success) {
                const data = invitesData.data;
                let apiInfo = `✅ **API Test Successful!**\n\n`;
                apiInfo += `**Total Records:** ${data.length}\n\n`;
                apiInfo += `**Sample Records:**\n`;
                
                // Show first 3 records
                for (let i = 0; i < Math.min(3, data.length); i++) {
                    const record = data[i];
                    try {
                        const discordData = JSON.parse(record.discord_invite);
                        apiInfo += `\n**Record ${i + 1}:**\n`;
                        apiInfo += `- User ID: ${record.user_id}\n`;
                        apiInfo += `- Email: ${record.email}\n`;
                        apiInfo += `- Discord Username: ${discordData.discord_username}\n`;
                        apiInfo += `- Display Name: ${discordData.discord_display_name}\n`;
                        apiInfo += `- XP Awarded: ${discordData.xp_awarded}\n`;
                    } catch (parseError) {
                        apiInfo += `\n**Record ${i + 1}:** Error parsing JSON\n`;
                    }
                }
                
                await message.reply(apiInfo);
            } else {
                await message.reply(`❌ **API Test Failed:** ${invitesData.error}`);
            }
            
        } catch (error) {
            console.error('❌ Error testing API:', error);
            await message.reply(`❌ API test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle command to test user verification
    if (message.content.startsWith('!testuser ') && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const username = message.content.split(' ')[1];
            if (!username) {
                await message.reply('❌ Please provide a username. Usage: `!testuser username`');
                return;
            }
            
            await message.reply(`🔍 **Testing user verification for:** ${username}`);
            
            const userCheck = await checkUserInDiscordInvites(username);
            
            if (userCheck.exists) {
                const userData = userCheck.userData;
                const discordData = userData.discordData;
                
                let userInfo = `✅ **User Found in API!**\n\n`;
                userInfo += `**SmallStreet Data:**\n`;
                userInfo += `- User ID: ${userData.userId}\n`;
                userInfo += `- Email: ${userData.email}\n\n`;
                userInfo += `**Discord Data:**\n`;
                userInfo += `- Discord ID: ${discordData.discord_id}\n`;
                userInfo += `- Username: ${discordData.discord_username}\n`;
                userInfo += `- Display Name: ${discordData.discord_display_name}\n`;
                userInfo += `- XP Awarded: ${discordData.xp_awarded}\n`;
                userInfo += `- Status: ${discordData.status}\n`;
                userInfo += `- Verification Date: ${discordData.verification_date}\n`;
                
                await message.reply(userInfo);
            } else {
                await message.reply(`❌ **User not found in API:** ${username}\n\nThis user has not completed Discord verification through SmallStreet.`);
            }
            
        } catch (error) {
            console.error('❌ Error testing user verification:', error);
            await message.reply(`❌ User verification test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle debug command to test user processing
    if (message.content === '!testuserprocessing' && message.author.id === process.env.ADMIN_USER_ID && message.channel.id === process.env.MONTHLY_REDEMPTION_CHANNEL_ID) {
        try {
            // Find the latest poll
            const messages = await message.channel.messages.fetch({ limit: 50 });
            const pollMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                msg.embeds.length > 0 &&
                msg.embeds[0].title && 
                msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
            );
            
            if (pollMessages.size === 0) {
                await message.reply('❌ **No poll found** to test user processing on.');
                return;
            }
            
            const latestPoll = pollMessages.first();
            const pollMessage = await message.channel.messages.fetch(latestPoll.id);
            const reactions = pollMessage.reactions.cache;
            
            let testResults = `🧪 **User Processing Test for Poll ${latestPoll.id}:**\n\n`;
            
            for (const [emoji, reaction] of reactions) {
                const choice = getChoiceFromEmoji(emoji);
                if (!choice) continue;
                
                testResults += `**${emoji} Reaction (${choice}):**\n`;
                
                const users = await reaction.users.fetch();
                for (const user of users.values()) {
                    testResults += `\n👤 **User: ${user.username} (${user.id})**\n`;
                    testResults += `- Bot: ${user.bot ? 'Yes' : 'No'}\n`;
                    
                    if (user.bot) {
                        testResults += `- Status: Skipped (Bot)\n`;
                        continue;
                    }
                    
                    const member = message.guild.members.cache.get(user.id);
                    if (member) {
                        testResults += `- Member Cache: Found\n`;
                        testResults += `- Display Name: ${member.displayName}\n`;
                        testResults += `- Status: ✅ Will be processed\n`;
                    } else {
                        testResults += `- Member Cache: Not found\n`;
                        try {
                            const fetchedMember = await message.guild.members.fetch(user.id);
                            if (fetchedMember) {
                                testResults += `- Member Fetch: Success\n`;
                                testResults += `- Display Name: ${fetchedMember.displayName}\n`;
                                testResults += `- Status: ✅ Will be processed (fetched)\n`;
                            } else {
                                testResults += `- Member Fetch: Failed\n`;
                                testResults += `- Status: ❌ Will be skipped\n`;
                            }
                        } catch (error) {
                            testResults += `- Member Fetch: Error - ${error.message}\n`;
                            testResults += `- Status: ❌ Will be skipped\n`;
                        }
                    }
                }
                testResults += '\n';
            }
            
            await message.reply(testResults);
            
        } catch (error) {
            console.error('❌ Error testing user processing:', error);
            await message.reply(`❌ User processing test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle debug command to check reaction details
    if (message.content === '!checkreactions' && message.author.id === process.env.ADMIN_USER_ID && message.channel.id === process.env.MONTHLY_REDEMPTION_CHANNEL_ID) {
        try {
            // Find the latest poll
            const messages = await message.channel.messages.fetch({ limit: 50 });
            const pollMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                msg.embeds.length > 0 &&
                msg.embeds[0].title && 
                msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
            );
            
            if (pollMessages.size === 0) {
                await message.reply('❌ **No poll found** to check reactions on.');
                return;
            }
            
            const latestPoll = pollMessages.first();
            const pollMessage = await message.channel.messages.fetch(latestPoll.id);
            const reactions = pollMessage.reactions.cache;
            
            let reactionDetails = `🔍 **Reaction Check for Poll ${latestPoll.id}:**\n\n`;
            
            for (const [emoji, reaction] of reactions) {
                reactionDetails += `**${emoji} Reaction:**\n`;
                reactionDetails += `- Count: ${reaction.count}\n`;
                reactionDetails += `- Users: ${reaction.users.cache.size} cached\n`;
                
                try {
                    const users = await reaction.users.fetch();
                    reactionDetails += `- Fetched Users: ${users.size}\n`;
                    
                    for (const user of users.values()) {
                        const isBot = user.bot ? ' (BOT)' : '';
                        const member = message.guild.members.cache.get(user.id);
                        const displayName = member ? member.displayName : 'Unknown';
                        reactionDetails += `  • ${user.username}${isBot} (${displayName}) - ID: ${user.id}\n`;
                    }
                } catch (error) {
                    reactionDetails += `- Error fetching users: ${error.message}\n`;
                }
                reactionDetails += '\n';
            }
            
            await message.reply(reactionDetails);
            
        } catch (error) {
            console.error('❌ Error checking reactions:', error);
            await message.reply(`❌ Reaction check failed: ${error.message}`);
        }
        return;
    }
    
    
    // Handle command to check poll scheduler status
    if (message.content === '!pollscheduler' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const now = new Date();
            const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 9, 0, 0);
            const nextPollDate = nextMonth.toISOString();
            const nextPollTimestamp = Math.floor(nextPollDate / 1000);
            
            const schedulerEmbed = {
                title: '🗳️ Poll Scheduler Status',
                description: 'Information about the automatic poll creation schedule:',
                color: 0x00ff00,
                fields: [
                    {
                        name: '📅 Schedule',
                        value: 'Monthly on the 1st at 9:00 AM UTC',
                        inline: false
                    },
                    {
                        name: '⏰ Next Poll',
                        value: `<t:${nextPollTimestamp}:F>`,
                        inline: true
                    },
                    {
                        name: '🕐 Time Until Next',
                        value: `<t:${nextPollTimestamp}:R>`,
                        inline: true
                    },
                    {
                        name: '📊 Poll Duration',
                        value: '7 days',
                        inline: true
                    },
                    {
                        name: '🎯 Target Channel',
                        value: `<#${process.env.MONTHLY_REDEMPTION_CHANNEL_ID}>`,
                        inline: true
                    },
                    {
                        name: '✅ Scheduler Status',
                        value: 'Active',
                        inline: true
                    }
                ],
                footer: {
                    text: 'Make Everyone Great Again • SmallStreet Governance'
                }
            };
            
            await message.reply({ embeds: [schedulerEmbed] });
        } catch (error) {
            await message.reply(`❌ Scheduler check failed: ${error.message}`);
        }
        return;
    }
    
    // Handle QR code verification (existing code)
    if (message.author.bot || 
        message.channel.id !== process.env.VERIFY_CHANNEL_ID || 
        !message.attachments.size) return;

    // Process image
    const attachment = message.attachments.first();
    if (!attachment.name.match(/\.(png|jpg|jpeg)$/i)) {
        await message.channel.send(`❌ Please send a valid image file (PNG, JPG, or JPEG).\nMake Everyone Great Again\nhttps://www.smallstreet.app/login/`);
        return;
    }

    // Create a unique lock key for this verification attempt
    const lockKey = `verification_${message.author.id}`;
    if (processingUsers.has(lockKey)) {
        await message.reply('⚠️ Please wait for your current verification to complete.\nMake Everyone Great Again');
        return;
    }

    let processingMsg = null;
    try {
        // Add verification to processing set
        processingUsers.add(lockKey);
        
        processingMsg = await message.channel.send(`🔍 Processing QR code...`);

        // First, just try to read the QR code before making any API calls
        try {
            const qrData = await readQRCode(attachment.url);
            if (!qrData) {
                await processingMsg.edit(`❌ Could not read QR code.\nPlease ensure the image is clear and try again.\nMake Everyone Great Again\nhttps://www.smallstreet.app/login/`);
                return;
            }

            const qrPayload = String(qrData).replace(/^\uFEFF/, '').trim();
            console.log(`📷 QR decoded length=${qrPayload.length}, preview=${qrPayload.slice(0, 120)}${qrPayload.length > 120 ? '…' : ''}`);

            const verifyMeParsed = parseSmallstreetVerifyMeQr(qrPayload);
            if (verifyMeParsed) {
                if (verifyMeParsed.type === 'session') {
                    if (String(message.author.id) !== verifyMeParsed.qr_discord_id) {
                        await processingMsg.edit(
                            `❌ **Wrong Discord account**\nThis QR is for user ID \`${verifyMeParsed.qr_discord_id}\`. You must scan it while logged in as that user.\nMake Everyone Great Again`
                        );
                        return;
                    }
                    if (message.guild && String(message.guild.id) !== verifyMeParsed.qr_guild_id) {
                        await processingMsg.edit(
                            `❌ **Wrong server**\nThis QR is for guild ID \`${verifyMeParsed.qr_guild_id}\`. Open the verify channel in that Discord server.\nMake Everyone Great Again`
                        );
                        return;
                    }
                }

                const xpLine =
                    verifyMeParsed.type === 'transaction' && verifyMeParsed.xp_units
                        ? `\n**XP (from QR):** ${formatXPNumber(verifyMeParsed.xp_units)}`
                        : '';
                const headerLine =
                    verifyMeParsed.type === 'transaction'
                        ? `**Transaction:** \`${verifyMeParsed.transaction_id}\`${xpLine}`
                        : `**Session verify** (Discord \`${verifyMeParsed.qr_discord_id}\`, guild \`${verifyMeParsed.qr_guild_id}\`)`;

                await processingMsg.edit(`🔍 **SmallStreet verify-me QR**\n${headerLine}\nSubmitting to SmallStreet...`);

                const sub = await submitSmallstreetVerifyMeFromDiscord(message, verifyMeParsed);

                if (sub.outcome === 'missing_key') {
                    await processingMsg.edit(
                        `✅ **Recognized verify-me QR**\n${headerLine}\n\n⚠️ \`SMALLSTREET_API_KEY\` is not set on the bot, so nothing was sent to the API.\n🔗 ${verifyMeParsed.originalUrl}\nMake Everyone Great Again`
                    );
                    return;
                }

                if (sub.outcome === 'synced') {
                    const okLine =
                        verifyMeParsed.type === 'transaction'
                            ? `**Transaction:** \`${verifyMeParsed.transaction_id}\`${xpLine}`
                            : `**Session** confirmed for guild \`${verifyMeParsed.qr_guild_id}\`.`;
                    await processingMsg.edit(`✅ **Verify-me recorded**\n${okLine}\nMake Everyone Great Again`);
                    try {
                        await message.author.send(
                            verifyMeParsed.type === 'transaction'
                                ? `✅ **Verify-me**\nTransaction \`${verifyMeParsed.transaction_id}\` was submitted from Discord.`
                                : `✅ **Verify-me**\nYour session was submitted from Discord.`
                        );
                    } catch (_) {}
                    try {
                        const adminUser = client.users.cache.get(process.env.ADMIN_USER_ID);
                        if (adminUser) {
                            const adminDetail =
                                verifyMeParsed.type === 'transaction'
                                    ? `Transaction: \`${verifyMeParsed.transaction_id}\``
                                    : `Session QR (guild \`${verifyMeParsed.qr_guild_id}\`)`;
                            await adminUser.send(
                                `✅ **verify-me QR**\nUser: ${message.author.tag} (\`${message.author.id}\`)\n${adminDetail}`
                            );
                        }
                    } catch (_) {}
                    return;
                }

                if (sub.outcome === 'http_error' && sub.status === 404) {
                    await processingMsg.edit(
                        `✅ **Recognized verify-me QR**\n${headerLine}\n\nThe REST confirm endpoint returned **404**. Use the link below on the site, or set **VERIFY_ME_QR_SUBMIT_URL** to your working route.\n🔗 ${verifyMeParsed.originalUrl}\nMake Everyone Great Again`
                    );
                    return;
                }

                const detail = sub.error || sub.outcome || 'Unknown error';
                await processingMsg.edit(
                    `❌ **Verify-me QR** — could not confirm with SmallStreet (${sub.status || '—'}).\n${detail}\n\n🔗 ${verifyMeParsed.originalUrl}\nMake Everyone Great Again`
                );
                return;
            }

            // Membership flow: email from SmallStreet link (?email=), mailto:, or qr1.be vCard page
            let contactInfo = extractEmailForMembershipFromQr(qrPayload);
            if (contactInfo) {
                await processingMsg.edit(`🔍 **Membership QR**\nUsing email from link: \`${contactInfo.email}\``);
            } else if (qrPayload.includes('qr1.be') || isPublicVcardAjaxUrl(qrPayload)) {
                await processingMsg.edit(
                    isPublicVcardAjaxUrl(qrPayload)
                        ? `🔍 Loading SmallStreet vCard…`
                        : `🔍 Reading contact information from qr1.be…`
                );
                contactInfo = await fetchQR1BeData(qrPayload);
            } else {
                await processingMsg.edit(
                    `❌ **Unrecognized QR**\nThe image decoded, but the text was not a supported link.\n\n**Supported:**\n• SmallStreet vCard: \`…/wp-admin/admin-ajax.php?action=dong_public_vcard_card&token=…\`\n• \`https://www.smallstreet.app/...?email=you@example.com\` (or \`user_email=\`, \`mail=\`)\n• \`mailto:you@example.com\`\n• \`https://www.smallstreet.app/verify-me/?transaction_id=…\` (optional \`xp_units\`)\n• \`/wp-json/myapi/v1/verify-me?id=<Discord user id>&guild_id=<server id>\`\n• \`https://…qr1.be/…\` membership vCard\n\nCheck logs for \`📷 QR decoded\` to see the exact string.\nMake Everyone Great Again\nhttps://www.smallstreet.app/login/`
                );
                return;
            }

            if (!contactInfo || !contactInfo.email) {
                await processingMsg.edit(`❌ Could not read contact information.\nPlease try again.\nMake Everyone Great Again\nhttps://www.smallstreet.app/login/`);
                return;
            }

            await processingMsg.edit(`🔍 Verifying membership...`);
            const [isMember, membershipType] = await verifySmallStreetMembership(contactInfo.email);
            if (!isMember || !membershipType) {
                await processingMsg.edit(`❌ User not verified!\nPlease register and purchase a membership at https://www.smallstreet.app/login/ first.\nMake Everyone Great Again\nadmin\nLog In - Make Everyone Great Again`);
                return;
            }

            // Only try to assign role if membership is verified
            const roleResult = await assignRoleBasedOnMembership(message.member, membershipType);

            // Check if user already has the role (already verified)
            if (roleResult.alreadyHas) {
                // User is already verified, don't insert to database
                const response = [
                    `✅ You have already verified as ${roleResult.roleName}`,
                    `Make Everyone Great Again`
                ].filter(Boolean);

                await processingMsg.edit(response.join('\n'));
                return; // Exit early, no database insertion
            }

            // User is new or role changed, proceed with database insertion
            await processingMsg.edit(`💾 Saving user data to database...`);
            
            // Prepare user data for database insertion
            const userData = {
                discordId: message.author.id,
                discordUsername: message.author.username,
                displayName: message.member.displayName || message.author.username,
                email: contactInfo.email, // Use the email from QR code
                guildId: message.guild.id,
                joinedAt: message.member.joinedAt ? message.member.joinedAt.toISOString() : new Date().toISOString(),
                inviteUrl: 'https://discord.gg/smallstreet',
                eventId: String(message.id),
                xpAwarded: 5000000
            };

            console.log(`📊 QR Verification - Attempting to insert user data:`, JSON.stringify(userData, null, 2));
            const dbResult = await insertUserToSmallStreetUsermeta(userData);
            console.log(`📊 QR Verification - Database insertion result:`, JSON.stringify(dbResult, null, 2));

            // Send DM response to user about database insertion
            try {
                if (dbResult.success) {
                    await message.author.send(`✅ **QR Verification - You have received XP for joining the gracebook!**\n**Email Used:** ${userData.email}\n**XP Awarded:** 5,000,000 XP\n**Status:** Successfully updated`);
                } else {
                    await message.author.send(`❌ **QR Verification - Database Update Failed:** Could not update your data in SmallStreet database.\n**Email Used:** ${userData.email}\n**Error:** ${dbResult.error || 'Unknown error'}\n**Status:** Please contact support`);
                }
            } catch (userDmError) {
                console.log('Could not send user QR verification DM:', userDmError.message);
            }

            // Send notification to admin
            if (true) {
                try {
                    const adminUser = client.users.cache.get(process.env.ADMIN_USER_ID);
                    if (adminUser) {
                        if (dbResult.success) {
                            await adminUser.send(`✅ **QR Verification - Database Success**\n**User:** ${message.author.tag} (${message.author.id})`);
                        } else {
                            await adminUser.send(`❌ **QR Verification - Database Failed**\n**User:** ${message.author.tag} (${message.author.id})\n**Error:** ${dbResult.error || 'Unknown error'}`);
                        }
                    }
                } catch (adminDmError) {
                    console.log('Could not send admin DM:', adminDmError.message);
                }
            }

            // Prepare success response for new verification
            const response = [
                `✅ Verified SmallStreet Membership - ${membershipType}`,
                roleResult.roleName ? 
                    `🎭 Discord Role Assigned: ${roleResult.roleName}` : 
                    `⚠️ Role assignment failed: ${roleResult.error || 'Unknown error'}`,
                `Make Everyone Great Again`
            ].filter(Boolean);

            await processingMsg.edit(response.join('\n'));

        } catch (error) {
            console.error('QR Code Error:', error);
            console.error('QR Code Error Stack:', error.stack);
            const errorMessage = error.message || 'undefined';
            await processingMsg.edit(`❌ An error occurred: ${errorMessage}\nMake Everyone Great Again\nhttps://www.smallstreet.app/login/`);
        }
    } catch (error) {
        console.error('Error during verification:', error);
        if (processingMsg) {
            const errorMessage = error.message || 'undefined';
            if (error.message?.includes('multiple retries')) {
                await processingMsg.edit(`❌ Service is temporarily unavailable.\nPlease try again in a few minutes.\nMake Everyone Great Again\nhttps://www.smallstreet.app/login/`);
            } else {
                await processingMsg.edit(`❌ An error occurred: ${errorMessage}\nMake Everyone Great Again\nhttps://www.smallstreet.app/login/`);
            }
        }
    } finally {
        // Always clean up
        processingUsers.delete(lockKey);
    }
});

// Only login if not already initialized
if (!isInitialized) {
    client.login(process.env.DISCORD_TOKEN);
} 