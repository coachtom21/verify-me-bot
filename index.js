require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fetch = require('node-fetch');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const express = require('express');
const cron = require('node-cron');

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Track bot instance
let isInitialized = false;

// Debug mode for database insertion
let debugMode = true;

// Healthcheck endpoint
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        botStatus: client?.isReady() ? 'online' : 'starting',
        instance: isInitialized ? 'primary' : 'initializing'
    });
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

// Test function to verify API endpoint
async function testSmallStreetAPI() {
    try {
        console.log('🧪 Testing SmallStreet Discord API endpoint...');
        const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/discord-user', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        console.log(`🧪 API Test Response: ${response.status} ${response.statusText}`);
        return response.ok;
    } catch (error) {
        console.error('🧪 API Test Failed:', error.message);
        return false;
    }
}


// Function to send Discord user data to SmallStreet API
async function insertUserToSmallStreetUsermeta(userData) {
    try {
        console.log(`🔗 Sending Discord user data to SmallStreet API: ${userData.discordUsername}`);
        console.log(`📤 User data:`, JSON.stringify(userData, null, 2));
        console.log(`🔑 API Key present:`, !!process.env.SMALLSTREET_API_KEY);
        
        // Prepare data in the correct format for the API
        const apiData = {
                discord_id: userData.discordId,
                discord_username: userData.discordUsername,
                discord_display_name: userData.displayName,
            email: userData.email,
            joined_at: userData.joinedAt.replace('T', ' ').replace('Z', ''),
                guild_id: userData.guildId,
            joined_via_invite: userData.inviteUrl,
            xp_awarded: 5000000
        };
        
        console.log(`📝 Sending data to API:`, JSON.stringify(apiData, null, 2));
        
        // Send data to the custom API endpoint
        try {
            console.log(`📝 Sending data to: https://www.smallstreet.app/wp-json/myapi/v1/discord-user`);
            console.log(`🔑 Using API Key: ${process.env.SMALLSTREET_API_KEY ? process.env.SMALLSTREET_API_KEY.substring(0, 8) + '...' : 'NOT SET'}`);
            console.log(`🔑 Full API Key: ${process.env.SMALLSTREET_API_KEY}`);
            console.log(`🔑 API Key Length: ${process.env.SMALLSTREET_API_KEY ? process.env.SMALLSTREET_API_KEY.length : 0}`);
            
            const requestHeaders = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`
            };
            
            console.log(`📤 Request Headers:`, JSON.stringify(requestHeaders, null, 2));
            console.log(`📤 Request Body:`, JSON.stringify(apiData, null, 2));
            console.log(`📤 Authorization Header Value: "Bearer ${process.env.SMALLSTREET_API_KEY}"`);
            
            const apiResponse = await fetchWithRetry('https://www.smallstreet.app/wp-json/myapi/v1/discord-user', {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(apiData)
            });
            
            const apiResult = await apiResponse.json();
            console.log(`📥 API Response Status: ${apiResponse.status} ${apiResponse.statusText}`);
            console.log(`📥 API Response Body:`, JSON.stringify(apiResult, null, 2));
            
            if (apiResponse.ok) {
                console.log(`✅ Successfully sent data to SmallStreet API`);
                return { success: true, data: apiResult };
        } else {
                console.error(`❌ API request failed:`, apiResult);
                return { success: false, error: `API request failed: ${JSON.stringify(apiResult)}` };
            }
        } catch (apiError) {
            console.error('❌ Error sending data to API:', apiError);
            console.error('❌ API error stack:', apiError.stack);
            return { success: false, error: `API error: ${apiError.message}`, details: apiError };
        }
        
    } catch (error) {
        console.error('❌ Error inserting user to SmallStreet usermeta:', error);
        console.error('❌ Error stack trace:', error.stack);
        console.error('❌ Error details:', {
            message: error.message,
            code: error.code,
            status: error.status,
            response: error.response ? {
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data
            } : 'No response object'
        });
        return { success: false, error: error.message, details: error };
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

// Modify the fetchQR1BeData function
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

        // Extract email
        const emailMatch = html.match(/([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (emailMatch) info.email = emailMatch[1].trim();

        return info.email ? info : null;
    } catch (error) {
        console.error('Error fetching qr1.be data:', error);
        throw new Error('Failed to fetch contact information after multiple retries');
    }
}

// Modify the verifySmallStreetMembership function to add debugging
async function verifySmallStreetMembership(email) {
    try {
        console.log(`🔍 Verifying membership for email: ${email}`);
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

// Function to send Discord user data to SmallStreet API
async function insertUserToSmallStreetUsermeta(userData) {
    try {
        console.log(`🔗 Sending Discord user data to SmallStreet API: ${userData.discordUsername}`);
        console.log(`📤 User data:`, JSON.stringify(userData, null, 2));
        console.log(`🔑 API Key present:`, !!process.env.SMALLSTREET_API_KEY);
        
        // Prepare data in the correct format for the API
        const apiData = {
            discord_id: userData.discordId,
            discord_username: userData.discordUsername,
            discord_display_name: userData.displayName,
            email: userData.email,
            joined_at: userData.joinedAt.replace('T', ' ').replace('Z', ''),
            guild_id: userData.guildId,
            joined_via_invite: userData.inviteUrl,
            xp_awarded: 5000000
        };
        
        console.log(`📝 Sending data to API:`, JSON.stringify(apiData, null, 2));
        
        // Send data to the custom API endpoint
        try {
            console.log(`📝 Sending data to: https://www.smallstreet.app/wp-json/myapi/v1/discord-user`);
            console.log(`🔑 Using API Key: ${process.env.SMALLSTREET_API_KEY ? process.env.SMALLSTREET_API_KEY.substring(0, 8) + '...' : 'NOT SET'}`);
            
            const requestHeaders = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`
            };
            
            console.log(`📤 Request Headers:`, JSON.stringify(requestHeaders, null, 2));
            console.log(`📤 Request Body:`, JSON.stringify(apiData, null, 2));
            
            const apiResponse = await fetchWithRetry('https://www.smallstreet.app/wp-json/myapi/v1/discord-user', {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(apiData)
            });
            
            const apiResult = await apiResponse.json();
            console.log(`📥 API Response Status: ${apiResponse.status} ${apiResponse.statusText}`);
            console.log(`📥 API Response Body:`, JSON.stringify(apiResult, null, 2));
            
            if (apiResponse.ok) {
                console.log(`✅ Successfully sent data to SmallStreet API`);
                return { success: true, data: apiResult };
            } else {
                console.error(`❌ API request failed:`, apiResult);
                return { success: false, error: `API request failed: ${JSON.stringify(apiResult)}` };
            }
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

// Enhanced poll system with three-choice resource allocation
async function createEnhancedMonthlyPoll() {
    try {
        const channel = client.channels.cache.get(process.env.MONTHLY_REDEMPTION_CHANNEL_ID);
        if (!channel) {
            console.error('❌ Monthly redemption channel not found');
            return { success: false, error: 'Channel not found' };
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
        const pollMessage = await channel.send({ embeds: [pollEmbed] });

        // Add reaction options for voting (three choices)
        const reactions = ['🕊️', '🗳️', '🆘'];
        for (const reaction of reactions) {
            await pollMessage.react(reaction);
        }

        console.log(`✅ Enhanced monthly poll created in ${channel.name}`);
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

// Format e-decimal notation
function formatEDecimal(xp) {
    if (xp === 0) return 'e-0';
    const exp = Math.floor(Math.log10(Math.abs(xp)));
    return `e-${exp}`;
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

                // Get user's XP level (simulate for now - you'll need to integrate with your XP system)
                const xpLevel = await getUserXPLevel(user.id) || 1000000; // Default to 1M XP
                const votingPower = getVotingPower(xpLevel);
                
                console.log(`🔍 Debug: User ${user.username} - XP: ${xpLevel}, Power: ${votingPower}x, Choice: ${choice}`);
                
                const voter = {
                    userId: user.id,
                    username: user.username,
                    displayName: member.displayName,
                    xpLevel: xpLevel,
                    votingPower: votingPower,
                    choice: choice,
                    votedAt: new Date().toISOString()
                };

                results[choice].count++;
                results[choice].weighted += votingPower;
                results[choice].voters.push(voter);
                results.uniqueVoters.add(user.id);
                
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

// Get user XP level (placeholder - integrate with your XP system)
async function getUserXPLevel(userId) {
    try {
        // This is a placeholder - you'll need to integrate with your actual XP system
        // For now, return a simulated XP level based on user ID
        const baseXP = 1000000; // 1M XP base
        const randomMultiplier = Math.floor(Math.random() * 100) + 1;
        return baseXP * randomMultiplier;
    } catch (error) {
        console.error('Error getting user XP level:', error);
        return 1000000; // Default to 1M XP
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
async function awardPollXP(voters, winningChoice) {
    try {
        const xpAwards = [];
        
        for (const voter of voters) {
            const xpAwarded = calculatePollXP(voter, winningChoice);
            
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

// Add XP event (placeholder - integrate with your XP system)
async function addXpEvent(userId, eventType, xp, meta = {}) {
    try {
        // This is a placeholder - you'll need to integrate with your actual XP system
        console.log(`💰 XP Event: User ${userId} earned ${formatEDecimal(xp)} (${xp.toLocaleString()} XP) for ${eventType}`);
        console.log(`📊 Meta:`, JSON.stringify(meta, null, 2));
        
        // Here you would integrate with your XP database system
        // For now, just log the event
        
        return { success: true };
    } catch (error) {
        console.error('Error adding XP event:', error);
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
        
        const xpResult = await awardPollXP(allVoters, winningChoice);

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

        return { success: true, data: { results: data, allocation, winningChoice, xpResult } };
    } catch (error) {
        console.error('Error displaying enhanced poll results:', error);
        return { success: false, error: error.message };
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
        const apiTest = await testSmallStreetAPI();
        console.log(`🧪 Startup API Test Result:`, apiTest);
        
        // Clear any existing bot messages in the verification channel
        const channel = client.channels.cache.get(process.env.VERIFY_CHANNEL_ID);
        if (channel) {
            // Fetch recent messages
            const messages = await channel.messages.fetch({ limit: 100 });
            const botMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                (msg.content.includes('Bot is online') || msg.content.includes('Make Everyone Great Again'))
            );
            
            // Delete old bot messages
            if (botMessages.size > 0) {
                await channel.bulkDelete(botMessages).catch(console.error);
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
                
                // Schedule automatic results processing for 7 days later
                setTimeout(async () => {
                    try {
                        console.log('📊 Processing scheduled poll results...');
                        const results = await displayEnhancedPollResults(pollResult.messageId);
                        
                        if (results.success) {
                            console.log('✅ Scheduled poll results processed successfully');
                        } else {
                            console.error('❌ Failed to process scheduled poll results:', results.error);
                        }
                    } catch (error) {
                        console.error('❌ Error processing scheduled poll results:', error);
                    }
                }, 7 * 24 * 60 * 60 * 1000); // 7 days
                
                // Send notification to admin
                const adminUser = client.users.cache.get(process.env.ADMIN_USER_ID);
                if (adminUser) {
                    await adminUser.send(`🗳️ **Monthly Resource Allocation Poll Created!**\n- Channel: <#${pollResult.channelId}>\n- Message ID: \`${pollResult.messageId}\`\n- Duration: 7 days\n- End Time: <t:${Math.floor(pollResult.endTime / 1000)}:F>\n- Options: 🕊️ Peace, 🗳️ Voting, 🆘 Disaster Relief\n- Auto-results: Enabled`);
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
            if (adminUser && debugMode) {
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
                await member.send(`🎉 **Welcome to Gracebook!**

🎯 **Next Steps:**
• Upload your QR code in <#${process.env.VERIFY_CHANNEL_ID}> to verify membership
• Get your Discord roles based on your membership level
• Receive **5,000,000 XP** rewards after verification

🔗 **SmallStreet Account:** https://www.smallstreet.app/login/

*Make Everyone Great Again* 🚀`);
                
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

    // Handle test command for database insertion
    if (message.content === '!testdb' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const testUserData = {
                discordId: message.author.id,
                discordUsername: message.author.username,
                displayName: message.author.displayName || message.author.username,
                email: `${message.author.username}@discord.local`,
                guildId: message.guild.id,
                joinedAt: new Date().toISOString(),
                inviteUrl: 'https://discord.gg/smallstreet'
            };
            
            await message.reply('🧪 Testing database insertion (simulating member join event)...');
            console.log('🧪 Starting detailed database test...');
            const result = await insertUserToSmallStreetUsermeta(testUserData);
            console.log('🧪 Database test completed:', result);
            
            await message.reply(`🧪 **Test Result:**\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
        } catch (error) {
            console.error('🧪 Database test failed:', error);
            await message.reply(`❌ Test failed: ${error.message}\n\nCheck console for detailed error logs.`);
        }
        return;
    }
    
    // Handle test command to simulate member join
    if (message.content === '!testjoin' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🧪 Simulating member join event...');
            
            // Simulate the member join data structure
            const member = {
                user: {
                    id: message.author.id,
                    username: message.author.username,
                    tag: message.author.tag
                },
                displayName: message.author.displayName || message.author.username,
                guild: {
                    id: message.guild.id
                }
            };
            
            // Prepare user data exactly like in guildMemberAdd
            const userData = {
                discordId: member.user.id,
                discordUsername: member.user.username,
                displayName: member.displayName,
                email: `${member.user.username}@discord.local`,
                guildId: member.guild.id,
                joinedAt: new Date().toISOString(),
                inviteUrl: 'https://discord.gg/smallstreet'
            };
            
            console.log('🧪 Simulating member join with data:', JSON.stringify(userData, null, 2));
            const dbResult = await insertUserToSmallStreetUsermeta(userData);
            
            await message.reply(`🧪 **Member Join Simulation Result:**\n\`\`\`json\n${JSON.stringify(dbResult, null, 2)}\n\`\`\``);
        } catch (error) {
            console.error('🧪 Member join simulation failed:', error);
            await message.reply(`❌ Simulation failed: ${error.message}`);
        }
        return;
    }
    
    // Handle test command for QR verification flow
    if (message.content === '!testqr' && message.author.id === process.env.ADMIN_USER_ID) {
        await message.reply('🧪 To test the QR verification flow, please upload a QR code image in this channel. The bot will:\n1. Scan the QR code\n2. Verify membership\n3. Assign role\n4. Save data to database\n\nThis is the complete verification flow with database insertion.');
        return;
    }
    
    // Handle test command for API endpoint
    if (message.content === '!testapi' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🧪 Testing API endpoint...');
            const apiTest = await testSmallStreetAPI();
            await message.reply(`🧪 API Test Result: ${apiTest ? '✅ API is accessible' : '❌ API is not accessible'}`);
        } catch (error) {
            await message.reply(`❌ API Test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle test command for API key
    if (message.content === '!testkey' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const apiKey = process.env.SMALLSTREET_API_KEY;
            if (!apiKey) {
                await message.reply('❌ API Key is not set in environment variables');
                return;
            }
            
            await message.reply(`🔑 **API Key Status:**\n- Present: ✅\n- Length: ${apiKey.length} characters\n- Full Key: \`${apiKey}\`\n- First 8 chars: ${apiKey.substring(0, 8)}...`);
            
            // Test with the exact same data as your working example
            const testData = {
                discord_id: '123456789',
                discord_username: 'JohnDoe',
                discord_display_name: 'John',
                email: 'realuser@smallstreet.app',
                joined_at: '2025-09-03 10:00:00',
                guild_id: '987654321',
                joined_via_invite: 'custom_invite',
                xp_awarded: 1000
            };
            
            console.log('🧪 Testing API with exact same data as working example...');
            console.log('🧪 Request data:', JSON.stringify(testData, null, 2));
            console.log('🧪 API Key:', apiKey);
            console.log('🧪 Authorization Header:', `Bearer ${apiKey}`);
            
            const response = await fetch('https://www.smallstreet.app/wp-json/myapi/v1/discord-user', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(testData)
            });
            
            const result = await response.json();
            console.log('🧪 API Response:', result);
            
            await message.reply(`🧪 **API Key Test Response:**\n- Status: ${response.status}\n- Result: \`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
            
        } catch (error) {
            console.error('🧪 API Key test error:', error);
            await message.reply(`❌ API Key test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle comprehensive debug command
    if (message.content === '!debug' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const debugInfo = {
                environment: {
                    hasApiKey: !!process.env.SMALLSTREET_API_KEY,
                    apiKeyLength: process.env.SMALLSTREET_API_KEY ? process.env.SMALLSTREET_API_KEY.length : 0,
                    hasVerifyChannel: !!process.env.VERIFY_CHANNEL_ID,
                    hasWelcomeChannel: !!process.env.WELCOME_CHANNEL_ID,
                    hasMegavoterRole: !!process.env.MEGAVOTER_ROLE_ID,
                    hasPatronRole: !!process.env.PATRON_ROLE_ID,
                    hasAdminUser: !!process.env.ADMIN_USER_ID
                },
                bot: {
                    isReady: client.isReady(),
                    guilds: client.guilds.cache.size,
                    users: client.users.cache.size,
                    intents: client.options.intents
                }
            };
            
            await message.reply(`🔍 **Debug Information:**\n\`\`\`json\n${JSON.stringify(debugInfo, null, 2)}\n\`\`\``);
            
            // Test API connectivity
            const apiTest = await testSmallStreetAPI();
            await message.reply(`🧪 **API Test:** ${apiTest ? '✅ Accessible' : '❌ Not accessible'}`);
            
        } catch (error) {
            await message.reply(`❌ Debug failed: ${error.message}`);
        }
        return;
    }
    
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
    
    // Handle command to toggle debug mode
    if (message.content === '!debugmode' && message.author.id === process.env.ADMIN_USER_ID) {
        debugMode = !debugMode;
        await message.reply(`🔧 **Debug Mode:** ${debugMode ? '✅ Enabled' : '❌ Disabled'}\n\nWhen enabled, you'll receive DMs with database insertion results when users join the server.`);
        return;
    }
    
    // Handle command to show current debug status
    if (message.content === '!debugstatus' && message.author.id === process.env.ADMIN_USER_ID) {
        await message.reply(`🔍 **Debug Status:**\n- Debug Mode: ${debugMode ? '✅ Enabled' : '❌ Disabled'}\n- Admin User ID: ${process.env.ADMIN_USER_ID}\n- API Key Present: ${!!process.env.SMALLSTREET_API_KEY}\n\nUse \`!debugmode\` to toggle debug notifications.`);
        return;
    }
    
    // Handle command to test member join event
    if (message.content === '!testmemberjoin' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const guild = message.guild;
            const botMember = guild.members.cache.get(client.user.id);
            const botPermissions = botMember.permissions;
            
            await message.reply(`🧪 **Member Join Event Test:**\n- Bot has GuildMembers intent: ${client.options.intents.has('GuildMembers')}\n- Bot can see members: ${botMember ? '✅ Yes' : '❌ No'}\n- Bot permissions: ${botPermissions.has('ViewChannel') ? '✅ View Channel' : '❌ No View Channel'}\n- Guild member count: ${guild.memberCount}\n\n**To test:** Invite someone to the server and check if you receive a DM notification.`);
        } catch (error) {
            await message.reply(`❌ Member join test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle command to test role assignment
    if (message.content === '!testrole' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            const PATRON_ROLE_ID = process.env.PATRON_ROLE_ID;
            const MEGAVOTER_ROLE_ID = process.env.MEGAVOTER_ROLE_ID;
            
            const patronRole = message.guild.roles.cache.get(PATRON_ROLE_ID);
            const megavoterRole = message.guild.roles.cache.get(MEGAVOTER_ROLE_ID);
            
            const botMember = message.guild.members.cache.get(client.user.id);
            const botRole = botMember.roles.highest;
            
            // Check specific permissions
            const canManageRoles = botMember.permissions.has('ManageRoles');
            const canManageGuild = botMember.permissions.has('ManageGuild');
            const canViewChannel = botMember.permissions.has('ViewChannel');
            const canSendMessages = botMember.permissions.has('SendMessages');
            
            // Check role hierarchy
            const canManagePatron = patronRole ? botRole.position > patronRole.position : false;
            const canManageMegavoter = megavoterRole ? botRole.position > megavoterRole.position : false;
            
            await message.reply(`🧪 **Role Assignment Test:**\n- PATRON_ROLE_ID: ${PATRON_ROLE_ID}\n- Patron role found: ${patronRole ? `✅ ${patronRole.name}` : '❌ NOT FOUND'}\n- MEGAVOTER_ROLE_ID: ${MEGAVOTER_ROLE_ID}\n- MEGAvoter role found: ${megavoterRole ? `✅ ${megavoterRole.name}` : '❌ NOT FOUND'}\n\n**Bot Permissions:**\n- Manage Roles: ${canManageRoles ? '✅ Yes' : '❌ No'}\n- Manage Guild: ${canManageGuild ? '✅ Yes' : '❌ No'}\n- View Channel: ${canViewChannel ? '✅ Yes' : '❌ No'}\n- Send Messages: ${canSendMessages ? '✅ Yes' : '❌ No'}\n\n**Role Hierarchy:**\n- Bot's highest role: ${botRole.name} (Position: ${botRole.position})\n- Patron role position: ${patronRole ? patronRole.position : 'N/A'}\n- Can manage Patron: ${canManagePatron ? '✅ Yes' : '❌ No'}\n- MEGAvoter role position: ${megavoterRole ? megavoterRole.position : 'N/A'}\n- Can manage MEGAvoter: ${canManageMegavoter ? '✅ Yes' : '❌ No'}`);
        } catch (error) {
            await message.reply(`❌ Role test failed: ${error.message}`);
        }
        return;
    }
    
    // Handle test command for membership verification and role assignment
    if (message.content === '!testmembership' && message.author.id === process.env.ADMIN_USER_ID) {
        try {
            await message.reply('🧪 Testing membership verification and role assignment...');
            
            // Test with a sample email (you can change this to a real email from your database)
            const testEmail = 'test@smallstreet.app'; // Change this to a real email
            
            console.log('🧪 Testing membership verification...');
            const [isMember, membershipType] = await verifySmallStreetMembership(testEmail);
            
            console.log('🧪 Testing role assignment...');
            const roleResult = await assignRoleBasedOnMembership(message.member, membershipType || 'pioneer');
            
            await message.reply(`🧪 **Membership Test Result:**\n- Email: ${testEmail}\n- Found in API: ${isMember ? '✅ Yes' : '❌ No'}\n- Membership Type: ${membershipType || 'None'}\n- Role Assignment: ${roleResult.roleName || 'Failed'}\n- Error: ${roleResult.error || 'None'}`);
            
        } catch (error) {
            console.error('🧪 Membership test failed:', error);
            await message.reply(`❌ Test failed: ${error.message}`);
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
        try {
            await message.reply('🗳️ Creating Monthly Resource Allocation poll...');
            
            const pollResult = await createEnhancedMonthlyPoll();
            
            if (pollResult.success) {
                await message.reply(`✅ **Enhanced Poll Created Successfully!**\n- Channel: <#${pollResult.channelId}>\n- Message ID: \`${pollResult.messageId}\`\n- Duration: 7 days\n- End Time: <t:${Math.floor(pollResult.endTime / 1000)}:F>\n- Options: 🕊️ Peace, 🗳️ Voting, 🆘 Disaster Relief`);
            } else {
                await message.reply(`❌ **Failed to create poll:** ${pollResult.error}`);
            }
        } catch (error) {
            console.error('❌ Error creating enhanced poll:', error);
            await message.reply(`❌ Poll creation failed: ${error.message}`);
        }
        return;
    }
    
    // Handle command to get enhanced poll results
    if (message.content.startsWith('!pollresults ') && message.author.id === process.env.ADMIN_USER_ID) {
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
    
    // Handle debug command for poll participation in monthly-redemption channel
    if (message.content === '!participation' && message.author.id === process.env.ADMIN_USER_ID && message.channel.id === process.env.MONTHLY_REDEMPTION_CHANNEL_ID) {
        try {
            await message.reply('🔍 **Debug Mode:** Searching for recent polls in this channel...');
            
            // Fetch recent messages to find poll messages
            const messages = await message.channel.messages.fetch({ limit: 50 });
            const pollMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                msg.embeds.length > 0 &&
                msg.embeds[0].title && 
                msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
            );
            
            if (pollMessages.size === 0) {
                await message.reply('❌ **No poll messages found** in this channel. Create a poll first with `!createpoll`');
                return;
            }
            
            // Get the most recent poll
            const latestPoll = pollMessages.first();
            const messageId = latestPoll.id;
            
            console.log(`🔍 Debug: Found poll message ID: ${messageId}`);
            
            // Debug: Check reactions on the poll message
            await message.reply(`📊 **Found Poll:** Analyzing participation for message \`${messageId}\`\n*Processing data...*`);
            
            // Debug: Show raw reaction data
            const pollMessage = await message.channel.messages.fetch(messageId);
            const reactions = pollMessage.reactions.cache;
            
            console.log(`🔍 Debug: Poll message reactions:`, reactions.size);
            for (const [emoji, reaction] of reactions) {
                console.log(`🔍 Debug: Reaction ${emoji}: ${reaction.count} count`);
            }
            
            // Debug: Check each reaction individually
            let detailedReactionInfo = '🔍 **Detailed Reaction Analysis:**\n';
            for (const [emoji, reaction] of reactions) {
                try {
                    const users = await reaction.users.fetch();
                    detailedReactionInfo += `\n**${emoji} (${reaction.count} total):**\n`;
                    
                    for (const user of users.values()) {
                        const isBot = user.bot ? ' (BOT)' : '';
                        const member = message.guild.members.cache.get(user.id);
                        const displayName = member ? member.displayName : 'Unknown Member';
                        detailedReactionInfo += `• ${user.username}${isBot} (${displayName})\n`;
                    }
                } catch (error) {
                    detailedReactionInfo += `• Error fetching users: ${error.message}\n`;
                }
            }
            
            await message.reply(`🔍 **Debug Info:**\n- Poll Message ID: \`${messageId}\`\n- Total Reactions: ${reactions.size}\n- Reaction Details: ${Array.from(reactions.entries()).map(([emoji, r]) => `${emoji}: ${r.count}`).join(', ')}\n\n${detailedReactionInfo}`);
            
            // Get enhanced poll results
            const results = await getEnhancedPollResults(messageId);
            
            if (!results.success) {
                await message.reply(`❌ **Failed to get poll data:** ${results.error}`);
                return;
            }
            
            const data = results.data;
            
            // Create comprehensive debug embed
            const debugEmbed = {
                title: '🔍 **Poll Participation Debug Report**',
                description: `**Poll Message ID:** \`${messageId}\`\n**Analysis Time:** ${new Date().toISOString()}`,
                color: 0x0099ff,
                fields: [
                    {
                        name: '📊 **Vote Counts**',
                        value: `🕊️ **Peace:** ${data.peace.count} votes\n🗳️ **Voting:** ${data.voting.count} votes\n🆘 **Disaster:** ${data.disaster.count} votes\n\n**Total Voters:** ${data.totalVoters}`,
                        inline: true
                    },
                    {
                        name: '⚖️ **Weighted Votes**',
                        value: `🕊️ **Peace:** ${data.peace.weighted} weighted\n🗳️ **Voting:** ${data.voting.weighted} weighted\n🆘 **Disaster:** ${data.disaster.weighted} weighted\n\n**Total Weighted:** ${data.peace.weighted + data.voting.weighted + data.disaster.weighted}`,
                        inline: true
                    },
                    {
                        name: '🏆 **Top Contributors**',
                        value: data.peace.voters.concat(data.voting.voters, data.disaster.voters)
                            .sort((a, b) => b.votingPower - a.votingPower)
                            .slice(0, 5)
                            .map((voter, index) => 
                                `${index + 1}. **${voter.displayName}**\n   • Choice: ${voter.choice}\n   • XP: ${formatEDecimal(voter.xpLevel)}\n   • Power: ${voter.votingPower}x`
                            ).join('\n\n') || 'No participants found',
                        inline: false
                    }
                ],
                footer: {
                    text: 'Debug Mode • Make Everyone Great Again • SmallStreet Governance'
                },
                timestamp: new Date().toISOString()
            };
            
            await message.reply({ embeds: [debugEmbed] });
            
            // Create detailed participant list
            const allVoters = [
                ...data.peace.voters,
                ...data.voting.voters,
                ...data.disaster.voters
            ];
            
            if (allVoters.length > 0) {
                let participantList = '📋 **Complete Participant List:**\n\n';
                
                // Group by choice
                const peaceVoters = data.peace.voters.map(v => `• **${v.displayName}** (${formatEDecimal(v.xpLevel)}, ${v.votingPower}x power)`);
                const votingVoters = data.voting.voters.map(v => `• **${v.displayName}** (${formatEDecimal(v.xpLevel)}, ${v.votingPower}x power)`);
                const disasterVoters = data.disaster.voters.map(v => `• **${v.displayName}** (${formatEDecimal(v.xpLevel)}, ${v.votingPower}x power)`);
                
                participantList += `🕊️ **Peace Initiatives (${data.peace.voters.length}):**\n${peaceVoters.join('\n') || 'None'}\n\n`;
                participantList += `🗳️ **Voting Programs (${data.voting.voters.length}):**\n${votingVoters.join('\n') || 'None'}\n\n`;
                participantList += `🆘 **Disaster Relief (${data.disaster.voters.length}):**\n${disasterVoters.join('\n') || 'None'}`;
                
                // Split into chunks if too long
                if (participantList.length > 2000) {
                    const chunks = participantList.match(/[\s\S]{1,2000}/g) || [];
                    for (let i = 0; i < chunks.length; i++) {
                        await message.reply(`**Participant List (Part ${i + 1}/${chunks.length}):**\n\`\`\`\n${chunks[i]}\n\`\`\``);
                    }
                } else {
                    await message.reply(`\`\`\`\n${participantList}\n\`\`\``);
                }
            } else {
                await message.reply('❌ **No participants found** in this poll.');
            }
            
            // Calculate and show fund allocation
            const allocation = calculateFundAllocation(data);
            const winningChoice = data.peace.weighted > data.voting.weighted && data.peace.weighted > data.disaster.weighted ? 'peace' :
                                data.voting.weighted > data.disaster.weighted ? 'voting' : 'disaster';
            
            const allocationEmbed = {
                title: '💰 **Fund Allocation Preview**',
                description: 'How community resources would be distributed based on current votes:',
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
                    },
                    {
                        name: '🏆 **Current Winner**',
                        value: `**${winningChoice.charAt(0).toUpperCase() + winningChoice.slice(1)}** is leading with ${allocation[winningChoice].percentage.toFixed(1)}% of weighted votes`,
                        inline: false
                    }
                ],
                footer: {
                    text: 'Debug Mode • Fund allocation based on current votes'
                }
            };
            
            await message.reply({ embeds: [allocationEmbed] });
            
            console.log(`✅ Debug participation report completed for poll ${messageId}`);
            
        } catch (error) {
            console.error('❌ Error in participation debug:', error);
            await message.reply(`❌ **Debug failed:** ${error.message}\n\nCheck console for detailed error logs.`);
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
    
    // Handle test command to simulate poll votes
    if (message.content === '!testvotes' && message.author.id === process.env.ADMIN_USER_ID && message.channel.id === process.env.MONTHLY_REDEMPTION_CHANNEL_ID) {
        try {
            await message.reply('🧪 **Test Mode:** Simulating votes for testing...');
            
            // Find the latest poll
            const messages = await message.channel.messages.fetch({ limit: 50 });
            const pollMessages = messages.filter(msg => 
                msg.author.id === client.user.id && 
                msg.embeds.length > 0 &&
                msg.embeds[0].title && 
                msg.embeds[0].title.includes('Monthly Resource Allocation Vote')
            );
            
            if (pollMessages.size === 0) {
                await message.reply('❌ **No poll found** to test votes on. Create a poll first with `!createpoll`');
                return;
            }
            
            const latestPoll = pollMessages.first();
            const pollMessage = await message.channel.messages.fetch(latestPoll.id);
            
            // Simulate some test votes
            const testVotes = [
                { emoji: '🕊️', count: 3 },
                { emoji: '🗳️', count: 2 },
                { emoji: '🆘', count: 1 }
            ];
            
            for (const vote of testVotes) {
                for (let i = 0; i < vote.count; i++) {
                    try {
                        await pollMessage.react(vote.emoji);
                        await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between reactions
                    } catch (error) {
                        console.log(`Could not add reaction ${vote.emoji}:`, error.message);
                    }
                }
            }
            
            await message.reply(`✅ **Test votes added:**\n- 🕊️ Peace: 3 votes\n- 🗳️ Voting: 2 votes\n- 🆘 Disaster: 1 vote\n\nNow run \`!participation\` to see the results!`);
            
        } catch (error) {
            console.error('❌ Error adding test votes:', error);
            await message.reply(`❌ Test votes failed: ${error.message}`);
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

            // Verify it's a qr1.be URL before proceeding with API calls
            if (!qrData.includes('qr1.be')) {
                await processingMsg.edit(`❌ Invalid QR code.\nMust be from qr1.be\nMake Everyone Great Again\nhttps://www.smallstreet.app/login/`);
                return;
            }

            // Now we know we have a valid QR code, proceed with API calls
            await processingMsg.edit(`🔍 Reading contact information...`);
            const contactInfo = await fetchQR1BeData(qrData);
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
                inviteUrl: 'https://discord.gg/smallstreet'
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

            // Send debug notification if enabled
            if (debugMode) {
                try {
                    const adminUser = client.users.cache.get(process.env.ADMIN_USER_ID);
                    if (adminUser) {
                        if (dbResult.success) {
                            await adminUser.send(`✅ **QR Verification - Database Success**\n**User:** ${message.author.tag} (${message.author.id})\n**Result:** \`\`\`json\n${JSON.stringify(dbResult, null, 2)}\n\`\`\``);
                        } else {
                            await adminUser.send(`❌ **QR Verification - Database Failed**\n**User:** ${message.author.tag} (${message.author.id})\n**Error:** \`\`\`json\n${JSON.stringify(dbResult, null, 2)}\n\`\`\``);
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