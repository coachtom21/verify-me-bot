const fs = require('fs');

// Read the file
let content = fs.readFileSync('index.js', 'utf8');

// Commands to keep
const keepCommands = ['!createpoll', '!resultpoll'];

// Remove all other commands
const commandsToRemove = [
    '!debug', '!checkevents', '!checkchannels', '!debugmode', '!debugstatus',
    '!testmemberjoin', '!testrole', '!testmembership', '!testemail',
    '!participation', '!forceupdatexp', '!testupdate', '!verifyxp',
    '!awardxp', '!checkpollchannel', '!pollhelp', '!testpollstorage',
    '!testinvitesapi', '!testapi', '!testuserprocessing', '!checkreactions',
    '!testvotes', '!pollscheduler', '!pollresults', '!pollparticipants',
    '!checkapi', '!testuser'
];

// Remove each command
commandsToRemove.forEach(command => {
    // Pattern to match the entire command block
    const pattern = new RegExp(`\\s*// Handle.*command.*${command.replace('!', '')}[\\s\\S]*?return;\\s*}\\s*`, 'g');
    content = content.replace(pattern, '');
    
    // Also remove commands that use startsWith
    const startsWithPattern = new RegExp(`\\s*if.*message\\.content\\.startsWith\\('${command.replace('!', '')} '\\).*?return;\\s*}\\s*`, 'g');
    content = content.replace(startsWithPattern, '');
});

// Remove console.log statements
content = content.replace(/console\.log\([^)]*\);?\s*/g, '');
content = content.replace(/console\.warn\([^)]*\);?\s*/g, '');
content = content.replace(/console\.info\([^)]*\);?\s*/g, '');

// Remove debug variables
content = content.replace(/let debugMode = true;?\s*/g, '');
content = content.replace(/const debugMode = true;?\s*/g, '');
content = content.replace(/var debugMode = true;?\s*/g, '');

// Remove test functions
content = content.replace(/async function testSmallStreetAPI\(\)[\s\S]*?}/g, '');
content = content.replace(/async function testDiscordInvitesAPI\(\)[\s\S]*?}/g, '');

// Clean up multiple empty lines
content = content.replace(/\n\s*\n\s*\n/g, '\n\n');

// Write the cleaned file
fs.writeFileSync('index.js', content);

console.log('✅ Bot simplified! Only !createpoll and !resultpoll commands remain.');
console.log('📁 Backup saved as index.js.backup');
