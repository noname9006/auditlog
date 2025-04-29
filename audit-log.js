const { Client, GatewayIntentBits, AuditLogEvent, PermissionsBitField } = require('discord.js');
const fs = require('fs/promises');
const path = require('path');
require('dotenv').config();

// Create a new client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Bot configuration
const config = {
  token: process.env.DISCORD_BOT_TOKEN,
  prefix: '!',
  batchSize: 100,
  maxConcurrentRequests: 5,
};

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Bot is in ${client.guilds.cache.size} guilds`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'fetchlogs') {
    try {
      // Check permissions first
      if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
        await message.channel.send('⚠️ Bot is missing required permission: View Audit Log');
        return;
      }
      
      console.log(`[${getCurrentTime()}] Received fetchlogs command from ${message.author.tag}`);
      
      // Extract type parameters from command arguments
      let typeNames = [];
      if (args.length > 0) {
        typeNames = args.map(arg => arg.toUpperCase());
        console.log(`[${getCurrentTime()}] Requested audit log types: ${typeNames.join(', ')}`);
        await message.channel.send(`Starting audit log export for types: ${typeNames.join(', ')}...`);
      } else {
        console.log(`[${getCurrentTime()}] Requested all audit log types`);
        await message.channel.send('Starting audit log export for all types...');
      }
      
      const startTime = Date.now();
      
      // Debug output of available types
      if (typeNames.length > 0) {
        typeNames.forEach(typeName => {
          if (!isNaN(Number(typeName))) {
            console.log(`[${getCurrentTime()}] Type ${typeName} is numeric, will use directly as type value`);
          } else {
            const typeValue = AuditLogEvent[typeName];
            console.log(`[${getCurrentTime()}] Type ${typeName} resolves to value: ${typeValue !== undefined ? typeValue : 'UNDEFINED'}`);
          }
        });
      }
      
      const logs = await fetchAllAuditLogs(message.guild, typeNames);
      
      // Group logs by type to show summary
      const logsByType = {};
      logs.forEach(log => {
        logsByType[log.actionType] = (logsByType[log.actionType] || 0) + 1;
      });
      
      console.log(`[${getCurrentTime()}] Log counts by type: ${JSON.stringify(logsByType)}`);
      
      const fileName = await saveLogsToFile(logs, message.guild.id);
      const endTime = Date.now();
      
      const summary = Object.entries(logsByType)
        .map(([type, count]) => `${type}: ${count}`)
        .join(', ');
        
      await message.channel.send(`✅ Exported ${logs.length} audit log entries to ${fileName} (${((endTime - startTime) / 1000).toFixed(2)}s)`);
      if (logs.length > 0) {
        await message.channel.send(`📊 Summary by type: ${summary}`);
      } else {
        await message.channel.send(`⚠️ No audit log entries were found for the specified types. This could be due to:\n- No events of this type have occurred\n- Events are older than Discord's retention period\n- Bot lacks permissions to view these events`);
      }
    } catch (error) {
      console.error(`[${getCurrentTime()}] Error fetching logs:`, error);
      await message.channel.send(`❌ Error fetching logs: ${error.message}`);
    }
  } else if (command === 'listtypes') {
    // Command to list all available audit log types
    console.log(`[${getCurrentTime()}] Listing available audit log types`);
    const typesList = Object.keys(AuditLogEvent)
      .filter(key => !isNaN(Number(AuditLogEvent[key])))
      .map(type => `${type}: ${AuditLogEvent[type]}`);
    
    console.log(`[${getCurrentTime()}] Found ${typesList.length} audit log types`);
    
    // Send types in chunks to avoid message length limits
    const chunkSize = 20;
    for (let i = 0; i < typesList.length; i += chunkSize) {
      const chunk = typesList.slice(i, i + chunkSize);
      await message.channel.send(`**Available Audit Log Types (${i+1}-${Math.min(i+chunkSize, typesList.length)}):**\n${chunk.join('\n')}`);
    }
  } else if (command === 'debug') {
    // Debug command to check bot permissions and audit log access
    const permissions = message.guild.members.me.permissions.toArray();
    const hasAuditLogAccess = message.guild.members.me.permissions.has(PermissionsBitField.Flags.ViewAuditLog);
    
    await message.channel.send(`
**Bot Debug Info:**
- Server: ${message.guild.name} (${message.guild.id})
- Has ViewAuditLog permission: ${hasAuditLogAccess ? '✅' : '❌'}
- Bot Permissions: ${permissions.join(', ')}
- Discord.js Version: ${require('discord.js').version}
- Node.js Version: ${process.version}
    `);
    
    try {
      // Test fetch a small sample of audit logs
      const testLogs = await message.guild.fetchAuditLogs({ limit: 1 });
      await message.channel.send(`✅ Successfully fetched a sample audit log entry. Audit logs are accessible.`);
    } catch (error) {
      await message.channel.send(`❌ Failed to fetch sample audit log: ${error.message}`);
    }
  }
});

function getCurrentTime() {
  return new Date().toISOString();
}

async function fetchAllAuditLogs(guild, typeNames = []) {
  console.log(`[${getCurrentTime()}] Starting to fetch audit logs for guild: ${guild.name} (${guild.id})`);
  
  // Get all audit log types or filter by requested types
  let auditLogTypes = [];
  
  if (typeNames.length > 0) {
    // Filter to only include requested types
    typeNames.forEach(typeName => {
      if (!isNaN(Number(typeName))) {
        // If it's a number string like "25", convert it directly to a number
        auditLogTypes.push(Number(typeName));
        console.log(`[${getCurrentTime()}] Added numeric type ${typeName}`);
      } else if (AuditLogEvent[typeName] !== undefined) {
        // Otherwise use it as a named constant
        auditLogTypes.push(Number(AuditLogEvent[typeName]));
        console.log(`[${getCurrentTime()}] Added type ${typeName} = ${AuditLogEvent[typeName]}`);
      } else {
        console.log(`[${getCurrentTime()}] Warning: Unknown audit log type "${typeName}"`);
      }
    });
  } else {
    // Use all types if none specified
    auditLogTypes = Object.keys(AuditLogEvent)
      .filter(key => !isNaN(Number(AuditLogEvent[key])))
      .map(key => Number(AuditLogEvent[key]));
    console.log(`[${getCurrentTime()}] Using all available audit log types (${auditLogTypes.length} types)`);
  }
  
  console.log(`[${getCurrentTime()}] Will fetch ${auditLogTypes.length} audit log types`);
  
  const allLogs = [];
  
  // Create batches for parallel processing
  const batches = [];
  let currentBatch = [];
  
  for (const type of auditLogTypes) {
    currentBatch.push(type);
    
    if (currentBatch.length >= config.maxConcurrentRequests) {
      batches.push([...currentBatch]);
      currentBatch = [];
    }
  }
  
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  console.log(`[${getCurrentTime()}] Created ${batches.length} batches for processing`);
  
  for (const batch of batches) {
    console.log(`[${getCurrentTime()}] Processing batch with ${batch.length} audit log types: ${batch.join(', ')}`);
    
    const batchPromises = batch.map(type => fetchLogsOfType(guild, type));
    const batchResults = await Promise.all(batchPromises);
    
    let batchTotalLogs = 0;
    batchResults.forEach((logs, index) => {
      const type = batch[index];
      const typeName = Object.keys(AuditLogEvent).find(key => AuditLogEvent[key] === type) || type;
      console.log(`[${getCurrentTime()}] Batch result for type ${typeName} (${type}): ${logs ? logs.length : 'null'} entries`);
      batchTotalLogs += logs ? logs.length : 0;
      
      if (logs && logs.length > 0) {
        allLogs.push(...logs);
      }
    });
    
    console.log(`[${getCurrentTime()}] Batch complete, added ${batchTotalLogs} logs to the collection`);
  }
  
  allLogs.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  
  console.log(`[${getCurrentTime()}] Fetched a total of ${allLogs.length} audit log entries`);
  return allLogs;
}

async function fetchLogsOfType(guild, type) {
  // Find the corresponding name for logging purposes
  const typeName = Object.keys(AuditLogEvent).find(key => 
    AuditLogEvent[key] === type
  ) || type;
  
  console.log(`[${getCurrentTime()}] Fetching logs of type: ${typeName} (${type})`);
  
  // Check for invalid type values
  if (isNaN(type)) {
    console.error(`[${getCurrentTime()}] Invalid audit log type: ${typeName} (${type}). Must be a valid number.`);
    return [];
  }
  
  const logs = [];
  let lastId = null;
  let hasMore = true;
  let attemptCount = 0;
  
  try {
    while (hasMore) {
      attemptCount++;
      const fetchOptions = { 
        limit: config.batchSize,
        type: type // Using numeric value
      };
      
      if (lastId) {
        fetchOptions.before = lastId;
      }
      
      console.log(`[${getCurrentTime()}] Fetching batch ${attemptCount} with options: ${JSON.stringify(fetchOptions)}`);
      
      const fetchedLogs = await guild.fetchAuditLogs(fetchOptions);
      
      console.log(`[${getCurrentTime()}] API response for ${typeName} (${type}): `, 
                  JSON.stringify({
                    size: fetchedLogs.entries.size,
                    hasEntries: fetchedLogs.entries.size > 0,
                    firstEntryAction: fetchedLogs.entries.size > 0 ? 
                      fetchedLogs.entries.first().action : null
                  }));
      
      if (fetchedLogs.entries.size === 0) {
        console.log(`[${getCurrentTime()}] No more entries for ${typeName} (${type})`);
        hasMore = false;
      } else {
        console.log(`[${getCurrentTime()}] Processing ${fetchedLogs.entries.size} entries for ${typeName} (${type})`);
        fetchedLogs.entries.forEach(entry => {
          logs.push({
            id: entry.id,
            type: entry.action,
            actionType: typeName, // Adding readable name
            executor: entry.executor ? {
              id: entry.executor.id,
              tag: entry.executor.tag
            } : null,
            target: entry.target ? {
              id: entry.target.id,
              type: entry.targetType,
              tag: entry.target.tag || null
            } : null,
            reason: entry.reason || null,
            changes: entry.changes || [],
            createdTimestamp: entry.createdTimestamp,
            createdAt: entry.createdAt.toISOString()
          });
        });
        
        lastId = fetchedLogs.entries.last()?.id;
        console.log(`[${getCurrentTime()}] Last ID for pagination: ${lastId}`);
        
        if (fetchedLogs.entries.size < config.batchSize) {
          console.log(`[${getCurrentTime()}] Batch size ${fetchedLogs.entries.size} < ${config.batchSize}, stopping pagination`);
          hasMore = false;
        }
      }
      
      // Safety check - don't loop forever
      if (attemptCount >= 1000) { // Extremely high number as fallback safety
  console.log(`[${getCurrentTime()}] Reached extraordinary number of attempts (1000) for ${typeName}, stopping as safety measure`);
  hasMore = false;
}
    }
    
    console.log(`[${getCurrentTime()}] Fetched ${logs.length} logs of type: ${typeName} (${type})`);
    return logs;
  } catch (error) {
    console.error(`[${getCurrentTime()}] Error fetching logs of type ${typeName} (${type}):`, error);
    return []; // Return empty array on error to continue with others
  }
}

async function saveLogsToFile(logs, guildId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `audit_logs_${guildId}_${timestamp}.json`;
  const filePath = path.join(__dirname, 'logs', fileName);
  
  await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });
  
  const summary = {};
  logs.forEach(log => {
    summary[log.actionType] = (summary[log.actionType] || 0) + 1;
  });
  
  await fs.writeFile(
    filePath,
    JSON.stringify({ 
      exportDate: new Date().toISOString(),
      guildId: guildId,
      totalEntries: logs.length,
      summary: summary,
      entries: logs 
    }, null, 2)
  );
  
  console.log(`[${getCurrentTime()}] Logs saved to ${filePath}`);
  return fileName;
}

// Added helper to create a test role update event
client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(config.prefix)) return;
  
  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  
  if (command === 'testroleevent') {
    try {
      // Check permissions
      if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply("I need Manage Roles permission to create a test role update event.");
      }
      
      // Find a role that the bot can modify (lower than bot's highest role)
      const botMember = message.guild.members.me;
      const botHighestRole = botMember.roles.highest;
      
      const targetRole = message.guild.roles.cache
        .filter(role => role.position < botHighestRole.position && !role.managed)
        .sort((a, b) => a.position - b.position)
        .first();
      
      if (!targetRole) {
        return message.reply("Couldn't find a suitable role to modify. Make sure I have a role higher than at least one other role.");
      }
      
      // Get the member to modify (preferably the message author)
      const targetMember = message.member;
      
      const hasRole = targetMember.roles.cache.has(targetRole.id);
      
      await message.reply(`Creating test role event: ${hasRole ? 'Removing' : 'Adding'} role ${targetRole.name} ${hasRole ? 'from' : 'to'} you.`);
      
      // Toggle the role
      if (hasRole) {
        await targetMember.roles.remove(targetRole);
        await message.reply(`Removed role ${targetRole.name}. This should create a MEMBER_ROLE_UPDATE audit log entry.`);
      } else {
        await targetMember.roles.add(targetRole);
        await message.reply(`Added role ${targetRole.name}. This should create a MEMBER_ROLE_UPDATE audit log entry.`);
      }
      
      await message.reply("Now try running `!fetchlogs MEMBER_ROLE_UPDATE` to see if it captures the event.");
      
    } catch (error) {
      console.error('[Role Event Test Error]', error);
      await message.reply(`Error creating test role event: ${error.message}`);
    }
  } else if (command === 'showaudittypes') {
    // Command to show the numeric values of audit log types
    // This helps users understand which numeric IDs correspond to which event types
    const types = Object.entries(AuditLogEvent)
      .filter(([key, value]) => !isNaN(Number(value)))
      .sort((a, b) => a[1] - b[1])
      .map(([key, value]) => `${value}: ${key}`);
    
    const chunkSize = 20;
    for (let i = 0; i < types.length; i += chunkSize) {
      const chunk = types.slice(i, i + chunkSize);
      await message.channel.send(`**Audit Log Type IDs (${i+1}-${Math.min(i+chunkSize, types.length)}):**\n${chunk.join('\n')}`);
    }
  }
});

client.login(config.token);