const { Client, GatewayIntentBits, AuditLogEvent } = require('discord.js');
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
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'fetchlogs') {
    try {
      // Extract type parameters from command arguments
      let typeNames = [];
      if (args.length > 0) {
        typeNames = args.map(arg => arg.toUpperCase());
        await message.channel.send(`Starting audit log export for types: ${typeNames.join(', ')}...`);
      } else {
        await message.channel.send('Starting audit log export for all types...');
      }
      
      const startTime = Date.now();
      
      const logs = await fetchAllAuditLogs(message.guild, typeNames);
      
      const fileName = await saveLogsToFile(logs, message.guild.id);
      const endTime = Date.now();
      
      await message.channel.send(`✅ Exported ${logs.length} audit log entries to ${fileName} (${((endTime - startTime) / 1000).toFixed(2)}s)`);
    } catch (error) {
      console.error('Error fetching logs:', error);
      await message.channel.send(`❌ Error fetching logs: ${error.message}`);
    }
  } else if (command === 'listtypes') {
    // Command to list all available audit log types
    const typesList = Object.keys(AuditLogEvent)
      .filter(key => !isNaN(Number(AuditLogEvent[key])))
      .map(type => `${type}: ${AuditLogEvent[type]}`);
    
    // Send types in chunks to avoid message length limits
    const chunkSize = 20;
    for (let i = 0; i < typesList.length; i += chunkSize) {
      const chunk = typesList.slice(i, i + chunkSize);
      await message.channel.send(`**Available Audit Log Types (${i+1}-${Math.min(i+chunkSize, typesList.length)}):**\n${chunk.join('\n')}`);
    }
  }
});

async function fetchAllAuditLogs(guild, typeNames = []) {
  console.log(`Starting to fetch audit logs for guild: ${guild.name}`);
  
  // Get all audit log types or filter by requested types
  let auditLogTypes = [];
  
  if (typeNames.length > 0) {
    // Filter to only include requested types
    typeNames.forEach(typeName => {
      if (AuditLogEvent[typeName] !== undefined) {
        auditLogTypes.push(Number(AuditLogEvent[typeName]));
      } else {
        console.log(`Warning: Unknown audit log type "${typeName}"`);
      }
    });
  } else {
    // Use all types if none specified
    auditLogTypes = Object.keys(AuditLogEvent)
      .filter(key => !isNaN(Number(AuditLogEvent[key])))
      .map(key => Number(AuditLogEvent[key]));
  }
  
  console.log(`Will fetch ${auditLogTypes.length} audit log types`);
  
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
  
  for (const batch of batches) {
    console.log(`Processing batch with ${batch.length} audit log types`);
    
    const batchPromises = batch.map(type => fetchLogsOfType(guild, type));
    const batchResults = await Promise.all(batchPromises);
    
    batchResults.forEach(logs => {
      if (logs && logs.length > 0) {
        allLogs.push(...logs);
      }
    });
  }
  
  allLogs.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  
  console.log(`Fetched a total of ${allLogs.length} audit log entries`);
  return allLogs;
}

async function fetchLogsOfType(guild, type) {
  // Find the corresponding name for logging purposes
  const typeName = Object.keys(AuditLogEvent).find(key => 
    AuditLogEvent[key] === type
  ) || type;
  
  console.log(`Fetching logs of type: ${typeName} (${type})`);
  const logs = [];
  let lastId = null;
  let hasMore = true;
  
  try {
    while (hasMore) {
      const fetchOptions = { 
        limit: config.batchSize,
        type: type // Using numeric value
      };
      
      if (lastId) {
        fetchOptions.before = lastId;
      }
      
      const fetchedLogs = await guild.fetchAuditLogs(fetchOptions);
      
      if (fetchedLogs.entries.size === 0) {
        hasMore = false;
      } else {
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
        
        if (fetchedLogs.entries.size < config.batchSize) {
          hasMore = false;
        }
      }
    }
    
    console.log(`Fetched ${logs.length} logs of type: ${typeName} (${type})`);
    return logs;
  } catch (error) {
    console.error(`Error fetching logs of type ${typeName} (${type}):`, error);
    return []; // Return empty array on error to continue with others
  }
}

async function saveLogsToFile(logs, guildId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `audit_logs_${guildId}_${timestamp}.json`;
  const filePath = path.join(__dirname, 'logs', fileName);
  
  await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });
  
  await fs.writeFile(
    filePath,
    JSON.stringify({ 
      exportDate: new Date().toISOString(),
      guildId: guildId,
      totalEntries: logs.length,
      entries: logs 
    }, null, 2)
  );
  
  console.log(`Logs saved to ${filePath}`);
  return fileName;
}

client.login(config.token);