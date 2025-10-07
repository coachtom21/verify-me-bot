# Discord QR Code Verification Bot

A Discord bot that verifies SmallStreet membership using QR codes and automatically tracks Discord server joins.

## Features
- QR Code scanning and processing
- SmallStreet membership verification
- Automatic role assignment
- Contact information extraction
- **NEW: Automatic user tracking when joining Discord server**
- **NEW: 5M XP award for Discord invite joins**
- **NEW: Profile command for viewing user details and XP**

## Setup

1. Clone the repository
```bash
git clone <your-repo-url>
cd discord-bot
```

2. Install dependencies
```bash
npm install
```

3. Create a `.env` file with the following variables:
```
DISCORD_TOKEN=your_discord_bot_token
VERIFY_CHANNEL_ID=your_channel_id
MEGAVOTER_ROLE_ID=your_megavoter_role_id
PATRON_ROLE_ID=your_patron_role_id
SMALLSTREET_API_KEY=your_smallstreet_api_key
WELCOME_CHANNEL_ID=your_welcome_channel_id
```

4. Start the bot
```bash
npm start
```

## Commands

### Profile Command
View user profile details including XP, roles, and membership status:

**Usage:** `/profile @username` or `/profile username`

**Location:** Only works in the `#wallet` channel (set via `WALLET_CHANNEL_ID` environment variable)

**API Endpoint:** `https://www.smallstreet.app/wp-json/myapi/v1/user-xp-data`

**Features:**
- Displays user's Discord username and avatar
- Shows total XP and voting power
- Lists Discord server roles
- Shows membership verification status
- Displays XP breakdown for verified users
- Shows power tier based on XP level

## Environment Variables

- `DISCORD_TOKEN`: Your Discord bot token
- `VERIFY_CHANNEL_ID`: ID of the channel where verification happens
- `MEGAVOTER_ROLE_ID`: Role ID for MEGAvoter members
- `PATRON_ROLE_ID`: Role ID for Patron members
- `SMALLSTREET_API_KEY`: API key for SmallStreet database operations
- `WELCOME_CHANNEL_ID`: ID of the channel for welcome messages (optional)
- `WALLET_CHANNEL_ID`: ID of the wallet channel for profile commands

## Deployment

This bot can be deployed to any Node.js hosting platform. Make sure to:
1. Set up environment variables in your hosting platform
2. Install dependencies using `npm install`
3. Start the bot using `npm start`
