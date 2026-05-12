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

**Admin Usage:** `!profile @username` or `!profile username` (can view any user's profile)
**Regular User Usage:** `!profile` (can only view their own profile)

**Location:** Only works in the `#wallet` channel (set via `WALLET_CHANNEL_ID` environment variable)

**API Endpoint:** `https://www.smallstreet.app/wp-json/myapi/v1/user-xp-data`

**Features:**
- Displays user's Discord username and avatar
- Shows total XP and voting power
- Lists Discord server roles
- Shows membership verification status
- Displays XP breakdown for verified users
- Shows power tier based on XP level
- **Admin-only**: Can view any user's profile by mentioning them
- **User restriction**: Regular users can only view their own profile

### Transaction Command
View detailed transaction history and meta data:

**Admin Usage:** `!transaction @username` or `!transaction username` (can view any user's transaction data)
**Regular User Usage:** `!transaction` (can only view their own transaction data)

**Location:** Only works in the `#wallet` channel (set via `WALLET_CHANNEL_ID` environment variable)

**Features:**
- Displays total XP summary with formatted numbers
- Shows detailed XP breakdown by transaction type
- Lists all meta keys and their values
- Shows transaction details for each XP source:
  - 🎉 Discord Invite XP
  - 🛒 Buyer Details XP
  - 🎭 Talent Show XP
  - 💼 Seller Details XP
  - 🗳️ Discord Poll XP
- Displays account status and verification information
- Shows membership level and email
- **Admin-only**: Can view any user's transaction data by mentioning them
- **User restriction**: Regular users can only view their own transaction data

## HumanBlockchain (optional)

If you run membership + XP on a **HumanBlockchain** WordPress site instead of SmallStreet, set:

- `HUMANBLOCKCHAIN_SITE_URL` — Site origin with no trailing slash (example: `https://yoursite.com` or `http://humanblockchain.local`)
- `HUMANBLOCKCHAIN_API_KEY` — **Same secret** as WordPress: `HB_DISCORD_BOT_API_KEY` in `wp-config.php`, or the `hb_discord_bot_api_key` option

When both are set, the bot calls:

- `GET /wp-json/hb/v1/discord-bot/membership?email=…`
- `GET /wp-json/hb/v1/discord-bot/wallet?discord_id=…` (preferred) or `?discord_username=…` — used by `!profile` / `!transaction` / `!transactions` in the wallet channel
- `POST /wp-json/hb/v1/discord-bot/verification` (same JSON body as the legacy SmallStreet `discord-user` route)

Optional: `HUMANBLOCKCHAIN_QR_EMAIL_HOSTS` — comma-separated extra hostnames for `?email=` on QR links. When HumanBlockchain mode is on, **`qr1.be`**, **`qrtiger.com`**, and **`media.qrtiger.com`** are always allowed for that flow.

**WordPress:** set the same secret in **Settings** (option `hb_discord_bot_api_key`) or `define('HB_DISCORD_BOT_API_KEY', '…');` in `wp-config.php`. It must match `HUMANBLOCKCHAIN_API_KEY` on the bot.

**Troubleshooting:** If verification always fails, confirm the bot can reach `HUMANBLOCKCHAIN_SITE_URL` (no localhost from cloud hosts unless tunneled), the Bearer key matches WordPress, and the email scraped from the vCard matches the WordPress user’s account email.

If `HUMANBLOCKCHAIN_SITE_URL` / `HUMANBLOCKCHAIN_API_KEY` are **not** set, behaviour stays on **smallstreet.app** (unchanged).

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
