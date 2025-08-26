# Discord QR Code Verification Bot

A Discord bot that verifies SmallStreet membership using QR codes.

## Features
- QR Code scanning and processing
- SmallStreet membership verification
- Automatic role assignment
- Contact information extraction

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
```

4. Start the bot
```bash
npm start
```

## Environment Variables

- `DISCORD_TOKEN`: Your Discord bot token
- `VERIFY_CHANNEL_ID`: ID of the channel where verification happens
- `MEGAVOTER_ROLE_ID`: Role ID for MEGAvoter members
- `PATRON_ROLE_ID`: Role ID for Patron members

## Deployment

This bot can be deployed to any Node.js hosting platform. Make sure to:
1. Set up environment variables in your hosting platform
2. Install dependencies using `npm install`
3. Start the bot using `npm start`
