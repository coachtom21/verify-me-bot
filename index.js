require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fetch = require('node-fetch');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const express = require('express');

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Track bot instance
let isInitialized = false;

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

// Modify the verifySmallStreetMembership function
async function verifySmallStreetMembership(email) {
    try {
        const response = await fetchWithRetry('https://www.smallstreet.app/wp-json/myapi/v1/api');
        const data = await response.json();
        
        for (const user of data) {
            if (user.user_email.toLowerCase() === email.toLowerCase() && user.membership_id) {
                return [true, user.membership_name];
            }
        }
        return [false, null];
    } catch (error) {
        console.error('Error verifying membership:', error);
        throw new Error('Failed to verify membership after multiple retries');
    }
}

// Assign role based on membership
async function assignRoleBasedOnMembership(member, membershipType) {
    try {
        const MEGAVOTER_ROLE_ID = process.env.MEGAVOTER_ROLE_ID;
        const PATRON_ROLE_ID = process.env.PATRON_ROLE_ID;

        // Check if user already has the roles
        const hasMegavoter = member.roles.cache.has(MEGAVOTER_ROLE_ID);
        const hasPatron = member.roles.cache.has(PATRON_ROLE_ID);

        // Return early if user already has the appropriate role
        if (membershipType.toLowerCase() === 'pioneer' && hasMegavoter) {
            return { roleName: "MEGAvoter", alreadyHas: true };
        } else if (membershipType.toLowerCase() === 'patron' && hasPatron) {
            return { roleName: "Patron", alreadyHas: true };
        }

        // Remove existing roles
        [MEGAVOTER_ROLE_ID, PATRON_ROLE_ID].forEach(async (roleId) => {
            const role = member.guild.roles.cache.get(roleId);
            if (role && member.roles.cache.has(roleId)) {
                await member.roles.remove(role);
            }
        });

        // Assign new role
        if (membershipType.toLowerCase() === 'pioneer') {
            const role = member.guild.roles.cache.get(MEGAVOTER_ROLE_ID);
            if (role) {
                await member.roles.add(role);
                return { roleName: "MEGAvoter", alreadyHas: false };
            }
        } else if (membershipType.toLowerCase() === 'patron') {
            const role = member.guild.roles.cache.get(PATRON_ROLE_ID);
            if (role) {
                await member.roles.add(role);
                return { roleName: "Patron", alreadyHas: false };
            }
        }
        return { roleName: null, alreadyHas: false };
    } catch (error) {
        console.error('Error assigning role:', error);
        return { roleName: null, alreadyHas: false };
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
            await welcomeChannel.send(`🎉 Welcome <@${member.user.id}> to the SmallStreet community!\n\n🎯 **Next Steps:**\n• Upload your QR code in <#${process.env.VERIFY_CHANNEL_ID}> to verify membership and get your Discord roles\n• You'll receive XP rewards after verification\n\n🔗 **SmallStreet Account:** https://www.smallstreet.app/login/\n\n*Make Everyone Great Again* 🚀`);
        }
        
        // Insert user data to database when they join (do this first)
        console.log(`💾 Inserting user data to database for new member: ${member.user.tag}`);
        console.log(`💾 User data being sent:`, JSON.stringify(userData, null, 2));
        
        try {
            const dbResult = await insertUserToSmallStreetUsermeta(userData);
            
            if (dbResult.success) {
                console.log(`✅ Successfully saved user data for ${member.user.tag} to database`);
            } else {
                console.error(`❌ Failed to save user data for ${member.user.tag}:`, dbResult.error);
            }
        } catch (dbError) {
            console.error(`❌ Database insertion error for ${member.user.tag}:`, dbError);
            console.error(`❌ Database error stack:`, dbError.stack);
        }

        // Send DM with instructions
        try {
            await member.send(`🎉 **Welcome to SmallStreet!**

🎯 **You've received 5,000,000 XP for joining!**

🎯 **Next Steps:**
• Upload your QR code in <#${process.env.VERIFY_CHANNEL_ID}> to verify membership
• Get your Discord roles based on your membership level

🔗 **SmallStreet Account:** https://www.smallstreet.app/login/

*Make Everyone Great Again* 🚀`);
                
            console.log(`📧 Sent welcome DM to ${member.user.tag}`);
        } catch (dmError) {
            console.error(`❌ Could not send welcome DM to ${member.user.tag}:`, dmError.message);
        }
        
    } catch (error) {
        console.error('Error handling member join:', error);
        
        // Send welcome message even if there's an error
        try {
            const welcomeChannel = client.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
            if (welcomeChannel) {
                await welcomeChannel.send(`🎉 Welcome <@${member.user.id}> to the SmallStreet community!\nPlease verify your membership by uploading your QR code in <#${process.env.VERIFY_CHANNEL_ID}>`);
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
        await message.reply('🧪 To test the QR verification flow, please upload a QR code image in this channel. The bot will:\n1. Scan the QR code\n2. Verify membership\n3. Assign role\n\nNote: User data is now saved when they join the server, not during QR verification.');
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

            // Prepare success response
            const response = [
                `✅ Verified SmallStreet Membership - ${membershipType}`,
                roleResult.roleName ? 
                    roleResult.alreadyHas ? 
                        `🎭 Already have ${roleResult.roleName} role` : 
                        `🎭 Discord Role Assigned: ${roleResult.roleName}` 
                    : '',
                `💾 User data was saved when you joined the server`,
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