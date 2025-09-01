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
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            lastError = error;
            console.log(`Attempt #${attempt} failed: ${error.message}. ${attempt < maxRetries ? `Retrying in ${delay/1000}s...` : 'Max retries reached.'}`);
            
            if (attempt === maxRetries) {
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // Exponential backoff
        }
    }
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

// Alternative function using custom endpoint
async function insertUserToSmallStreetCustomAPI(userData) {
    try {
        const response = await fetchWithRetry('http://smallstreet.local/wp-json/myapi/v1/discord-user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SMALLSTREET_API_KEY}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify({
                discord_id: userData.discordId,
                discord_username: userData.discordUsername,
                discord_display_name: userData.displayName,
                joined_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
                guild_id: userData.guildId,
                joined_via_invite: userData.inviteUrl || 'https://discord.gg/smallstreet',
                xp_type: 'discord_invite',
                xp_awarded: 5000000,
                status: 'completed',
                verification_date: new Date().toISOString().replace('T', ' ').replace('Z', '')
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
        
        // Prepare user data for database insertion
        const userData = {
            discordId: member.user.id,
            discordUsername: member.user.username,
            displayName: member.displayName || member.user.username,
            guildId: member.guild.id,
            joinedAt: new Date().toISOString(),
            inviteUrl: 'https://discord.gg/smallstreet' // You can make this dynamic if needed
        };

        // Insert user data into SmallStreet database
        const dbResult = await insertUserToSmallStreetCustomAPI(userData);
        
        if (dbResult.success) {
            console.log(`✅ User ${member.user.tag} successfully added to SmallStreet database`);
            
            // Send welcome message to server
            const welcomeChannel = client.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
            if (welcomeChannel) {
                await welcomeChannel.send(`🎉 Welcome <@${member.user.id}> to the SmallStreet community!\nYou've been awarded 5M XP for joining via Discord invite!\nPlease verify your membership by uploading your QR code in <#${process.env.VERIFY_CHANNEL_ID}>`);
            }
        } else {
            console.error(`❌ Failed to add user ${member.user.tag} to database:`, dbResult.error);
            
            // Still send welcome message even if DB insert fails
            const welcomeChannel = client.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
            if (welcomeChannel) {
                await welcomeChannel.send(`🎉 Welcome <@${member.user.id}> to the SmallStreet community!\nPlease verify your membership by uploading your QR code in <#${process.env.VERIFY_CHANNEL_ID}>`);
            }
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
                `Make Everyone Great Again`
            ].filter(Boolean);

            await processingMsg.edit(response.join('\n'));

        } catch (error) {
            console.error('QR Code Error:', error);
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