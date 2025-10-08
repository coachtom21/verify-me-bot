# 🗳️ Poll System Structure Diagram

## Poll Creation Flow

```
Admin Command: !createpoll
    ↓
createEnhancedMonthlyPoll()
    ↓
Create Poll Embed with 3 Options
    ↓
Post to #monthly-redemption Channel
    ↓
Add Reaction Emojis (🕊️ 🗳️ 🆘)
    ↓
Poll is Live for 7 Days
```

## Voting Process

```
User Reacts to Poll
    ↓
Check User Verification Status
    ↓
Get User XP Level from Database
    ↓
Calculate Voting Power (1x-100x)
    ↓
Store Vote Data in Database
    ↓
Update Poll Results in Real-time
```

## Results Processing

```
Poll Ends (7 days) OR !pollresults Command
    ↓
getEnhancedPollResults()
    ↓
Count Raw Votes & Calculate Weighted Votes
    ↓
Determine Winning Choice
    ↓
calculatePollXP() for Each Voter
    ↓
awardPollXP() - Update Database
    ↓
displayEnhancedPollResults() - Show Results
```

## Database Structure

```
WordPress Database (SmallStreet API)
├── Initial Vote Entry
│   ├── poll_id: Discord Message ID
│   ├── vote: 'peace' | 'voting' | 'disaster'
│   ├── xp_awarded: 1M (base XP)
│   ├── status: 'submitted'
│   └── vote_type: 'monthly_poll'
│
└── Final XP Entry (after results)
    ├── poll_id: Same Message ID
    ├── vote: 'final_xp_award'
    ├── xp_awarded: 1M-16M (calculated)
    ├── status: 'final_awarded'
    └── vote_type: 'xp_final_award'
```

## XP Calculation Matrix

```
Base XP: 1M (everyone gets this)

+ Winning Bonus: 5M (if your choice wins)
+ Top Contributor: 10M (if voting power ≥ 25x)

Total Possible XP: 1M + 5M + 10M = 16M XP
```

## Voting Power Tiers

```
XP Level          →  Voting Power
e+0 to e+6        →  1x
e+6+              →  2x  
e+12+             →  5x
e+24+             →  10x
e+48+             →  25x (Top Contributor)
e+120+            →  50x
e+168+            →  100x (Maximum)
```

## Poll Options Structure

```
🕊️ Peace Initiatives
├── Description: Community building, conflict resolution
├── XP Multiplier: 1.0x
└── Example: $536,000 allocation

🗳️ Voting Programs  
├── Description: Democratic participation, voter education
├── XP Multiplier: 1.5x
└── Example: $321,000 allocation

🆘 Disaster Relief
├── Description: Emergency response, humanitarian aid
├── XP Multiplier: 2.0x
└── Example: $143,000 allocation
```

## Command Structure

```
Admin Commands:
├── !createpoll
│   └── Creates new monthly poll
├── !pollresults <message_id>
│   └── Processes results & awards XP
├── !pollparticipants <message_id>
│   └── Shows detailed participant list
├── !participation
│   └── Auto-finds latest poll
├── !checkpollchannel
│   └── Verifies channel access
└── !pollhelp
    └── Shows all commands

User Actions:
└── React to poll message
    ├── 🕊️ = Peace Initiatives
    ├── 🗳️ = Voting Programs
    └── 🆘 = Disaster Relief
```

## API Endpoints

```
SmallStreet API Integration:
├── GET /api/poll-xp/:pollId
│   └── Retrieve XP data for specific poll
├── GET /api/polls-xp
│   └── Get all polls with XP summary
└── POST /wp-json/myapi/v1/discord-poll
    └── Store poll data in WordPress database
```

## Error Handling

```
Vote Processing:
├── User Verification Check
├── Duplicate Vote Prevention
├── Bot Reaction Filtering
└── Database Error Recovery

XP Awarding:
├── Multiple Update Methods
├── Fallback Mechanisms
├── Error Logging
└── Success Verification
```

---

*This diagram illustrates the complete structure and flow of the poll system in the VerifyMe Bot.*








