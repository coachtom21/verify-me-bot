# 🗳️ Monthly Poll Guide for Users

## What is the Monthly Poll System?

The VerifyMe Bot features a **Monthly Resource Allocation Poll** where community members vote on how to distribute $1,000,000 in community resources. Your vote helps decide which causes receive funding each month!

## 🎯 How to Participate

### Step 1: Find the Poll
- Look for polls in the **#monthly-redemption** channel
- Polls are created monthly and run for **7 days**
- Each poll shows three resource allocation options

### Step 2: Vote by Reacting
Simply click on one of these reaction emojis on the poll message:

| Emoji | Choice | What it supports |
|-------|--------|------------------|
| 🕊️ | **Peace Initiatives** | Community building, conflict resolution, solidarity programs |
| 🗳️ | **Voting Programs** | Democratic participation, voter education, civic engagement |
| 🆘 | **Disaster Relief** | Emergency response, humanitarian aid, crisis support |

### Step 3: Get Rewarded
- **Everyone gets 1M XP** just for voting!
- **Winners get 5M bonus XP** if their choice wins
- **Top contributors get 10M bonus XP** (if you have high voting power)

## 💪 Your Voting Power

Your vote counts more based on your XP level! The more active you are in the community, the more influence your vote has.

### Voting Power Tiers

| Your XP Level | Voting Power | What this means |
|---------------|--------------|-----------------|
| **e+0 to e+6** | 1x | Standard voting power |
| **e+6+** | 2x | Your vote counts double! |
| **e+12+** | 5x | 5x more influence |
| **e+24+** | 10x | 10x more influence |
| **e+48+** | 25x | **Top Contributor** - Major influence! |
| **e+120+** | 50x | **Elite Contributor** - Huge influence! |
| **e+168+** | 100x | **Maximum Power** - Your vote is super powerful! |

### How to Increase Your Voting Power
- **Get verified** with SmallStreet (upload your vCard to #verify-me)
- **Stay active** in the community
- **Participate regularly** in polls and other activities
- **Earn XP** through various community activities

## 💰 XP Rewards Breakdown

### Base Rewards (Everyone Gets These)
- **1M XP** - Just for voting (regardless of which choice wins)

### Bonus Rewards
- **+5M XP** - If your chosen option wins the poll
- **+10M XP** - If you're a Top Contributor (25x+ voting power)

### Maximum Possible Rewards
- **16M XP total** - If you're a Top Contributor AND your choice wins!

## 📊 How Poll Results Work

### Weighted Voting System
Your vote doesn't just count as "1 vote" - it's weighted based on your XP level:

**Example:**
- 5 people vote for Peace (average 3x power each) = 15 weighted votes
- 3 people vote for Voting (average 3x power each) = 9 weighted votes  
- 2 people vote for Disaster (average 2x power each) = 4 weighted votes
- **Peace wins** with 15 weighted votes!

### Fund Allocation
The $1M is distributed proportionally based on weighted votes:
- **Peace**: 53.6% = $536,000
- **Voting**: 32.1% = $321,000
- **Disaster**: 14.3% = $143,000

## ⏰ Poll Schedule & Automation

### 🤖 Automated Poll System
The poll system is **fully automated**! You don't need to wait for admins to create polls manually.

- **Automatic Creation**: New polls are created automatically on the **1st day of every month at 9:00 AM UTC**
- **Automatic Results**: Polls automatically end and process results after exactly **7 days**
- **No Manual Intervention**: The entire process runs without admin involvement

### 📅 Poll Timeline
- **Day 1**: Poll automatically created and posted to #monthly-redemption
- **Days 1-7**: Voting period (you can vote anytime during these 7 days)
- **Day 8**: Poll automatically ends and results are processed **automatically**
- **Day 8+**: XP rewards are distributed to all participants **automatically**

### 🤖 Automatic Results Processing
The bot automatically processes poll results after exactly 7 days using a built-in timer:

- **No Manual Intervention**: Results are calculated and posted automatically
- **Automatic XP Distribution**: All XP rewards are distributed without admin action
- **Automatic Notifications**: Results are posted to the channel and DMs sent to participants
- **Built-in Timer**: Uses `setTimeout` to trigger exactly 7 days after poll creation

### 🔔 What You Can Expect
- **Consistent Schedule**: Always know when the next poll will appear
- **Reliable Timing**: No delays or missed polls due to human error
- **Automatic Notifications**: Admins get notified when polls are created
- **Seamless Experience**: Just vote and earn XP - the system handles everything else!

### ⚙️ Behind the Scenes Automation
The bot automatically handles these tasks without any human intervention:

1. **Poll Creation** (1st of month, 9:00 AM UTC)
   - Creates poll embed with all three options
   - Posts to #monthly-redemption channel
   - Adds reaction emojis (🕊️ 🗳️ 🆘)
   - Schedules automatic results processing

2. **Vote Processing** (Real-time)
   - Tracks all reactions as they happen
   - Calculates voting power based on user XP
   - Stores votes in database
   - Updates poll results in real-time

3. **Results Processing** (Automatically after exactly 7 days)
   - **Automatic Trigger**: Built-in timer fires exactly 7 days after poll creation
   - Calculates weighted vote totals
   - Determines winning choice
   - Calculates final XP rewards for all voters
   - Updates database with final XP amounts
   - Displays comprehensive results in the channel
   - Sends DM notifications to all participants
   - **No Admin Action Required**: Everything happens automatically

4. **Error Handling**
   - Logs all activities for monitoring
   - Notifies admins of any issues
   - Has fallback mechanisms for reliability

## 🔍 Understanding Poll Results

When a poll ends, you'll see results like this:

```
📊 Monthly Poll Results - Resource Allocation
Community has spoken! Here are the weighted results and fund allocation.

🕊️ Peace Initiatives
Votes: 5
Weighted: 15
Allocation: 53.6%
Fund: $536,000

🗳️ Voting Programs  
Votes: 3
Weighted: 9
Allocation: 32.1%
Fund: $321,000

🆘 Disaster Relief
Votes: 2
Weighted: 4
Allocation: 14.3%
Fund: $143,000

🏆 Winning Choice
Peace won with 53.6% of weighted votes

👥 Participation
Total Voters: 10
XP Awards: Distributed
Total Weighted: 28
```

## 🤖 Automation Benefits

### Why Automation Matters for Users
- **Never Miss a Poll**: You can count on polls appearing every month without fail
- **Fair & Consistent**: Everyone gets the same 7-day voting window
- **Reliable Rewards**: XP is distributed automatically and consistently
- **No Delays**: No waiting for admins to manually create or end polls
- **Predictable Schedule**: You can plan ahead knowing exactly when polls will appear

### How to Track Automation Status
- **Next Poll Date**: Admins can check `!pollscheduler` to see when the next poll will be created
- **Poll History**: Previous polls remain visible in #monthly-redemption for reference
- **Consistent Timing**: Always on the 1st of the month at 9:00 AM UTC

## ❓ Frequently Asked Questions

### Q: Do I need to be verified to vote?
A: You can vote without being verified, but you'll get reduced benefits. Get verified by uploading your vCard to #verify-me for full XP rewards!

### Q: Can I change my vote?
A: No, once you react to a poll, your vote is locked in. Choose carefully!

### Q: What if I don't vote?
A: You miss out on 1M+ XP rewards and the chance to influence how community resources are allocated.

### Q: How do I know if I'm a Top Contributor?
A: Check your XP level! If you have e+48 or higher, you're a Top Contributor with 25x+ voting power.

### Q: When are XP rewards given?
A: XP is awarded immediately when you vote (1M base), then additional bonuses are calculated and awarded when the poll ends.

### Q: Can I see who else voted?
A: Admins can see participant lists, but regular users can only see the total vote counts in results.

### Q: What if the automation fails?
A: The system has built-in error handling and logging. If there are issues, admins will be notified and can manually create polls if needed.

### Q: How do I know when the next poll will be created?
A: Polls are created automatically on the 1st of every month at 9:00 AM UTC. You can ask an admin to check the scheduler status if you want to know the exact timing.

## 👑 Admin Roles & Permissions

### 🔐 Admin-Only Commands
Only users with admin privileges (set via `ADMIN_USER_ID` environment variable) can use these commands:

| Command | Purpose | Usage |
|---------|---------|-------|
| `!createpoll` | Create a new monthly poll manually | `!createpoll` |
| `!pollresults <message_id>` | Process poll results early | `!pollresults 1234567890` |
| `!pollparticipants <message_id>` | View detailed participant list | `!pollparticipants 1234567890` |
| `!participation` | Auto-find and analyze latest poll | `!participation` |
| `!checkpollchannel` | Verify poll channel accessibility | `!checkpollchannel` |
| `!pollscheduler` | Check automation status and next poll date | `!pollscheduler` |
| `!pollhelp` | Show all admin commands | `!pollhelp` |

### 🛠️ Admin Capabilities

#### **Poll Management**
- **Manual Poll Creation**: Create polls outside the automated schedule
- **Early Results Processing**: End polls before the 7-day timer expires
- **Debug Commands**: Troubleshoot poll issues and check system status
- **Channel Verification**: Ensure the poll channel is working properly

#### **Monitoring & Analytics**
- **Participant Analysis**: See who voted and their voting power
- **XP Tracking**: Monitor XP distribution and rewards
- **System Status**: Check if automation is working correctly
- **Error Handling**: Receive notifications when things go wrong

#### **Override Capabilities**
- **Manual Intervention**: Step in if automation fails
- **Emergency Actions**: Force poll creation or results processing
- **System Recovery**: Fix issues and restart processes

### 🔔 Admin Notifications
Admins receive automatic notifications for:
- **Poll Creation**: When automated polls are created successfully
- **Poll Failures**: When automated poll creation fails
- **System Errors**: When there are technical issues
- **Member Events**: When new members join the server

### 🚨 Emergency Procedures
If something goes wrong with the automated system:
1. **Check Status**: Use `!pollscheduler` to see if automation is working
2. **Manual Creation**: Use `!createpoll` to create a poll manually
3. **Force Results**: Use `!pollresults <message_id>` to process results
4. **Debug Issues**: Use `!participation` to analyze current poll status

## 🎉 Tips for Maximum Impact

1. **Get verified first** - This ensures you get full XP rewards
2. **Vote early** - Don't wait until the last minute
3. **Stay active** - The more XP you earn, the more powerful your vote becomes
4. **Read the descriptions** - Each option supports different important causes
5. **Encourage others** - More participation means more community engagement!

## 🆘 Need Help?

If you have questions about the poll system:
- Check the #monthly-redemption channel for active polls
- Ask in the general chat for community help
- Contact admins if you're having technical issues

---

**Remember**: Your vote matters! Every month, the community decides together how to allocate resources that can make a real difference. Participate, earn XP, and help shape the future of our community! 🌟
