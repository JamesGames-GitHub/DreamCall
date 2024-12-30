const { Client, GatewayIntentBits, PermissionsBitField, ChannelType, EmbedBuilder, REST, Routes, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');

require('dotenv').config(); // Load environment variables from .env file

const BOT_TOKEN = process.env.BOT_TOKEN;
const VC_LOG_CHANNEL_ID = process.env.VC_LOG_CHANNEL_ID;
const HUB_CHANNEL_ID = process.env.HUB_CHANNEL_ID;
const LOGS_DIRECTORY = process.env.LOGS_DIRECTORY || './logs';
const EMPTY_CHANNEL_TIMEOUT = parseInt(process.env.EMPTY_CHANNEL_TIMEOUT || '300000'); // Default 5 mins
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.CLIENT_ID;

const DATA_FILE = './data.json';
const ACTIVE_CHANNELS_FILE = './active_channels.json';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates, // REQUIRED for voiceStateUpdate
        GatewayIntentBits.GuildMembers
    ]
});

if (!fs.existsSync(LOGS_DIRECTORY)) fs.mkdirSync(LOGS_DIRECTORY);

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ trustedUsers: {}, blacklist: [] }, null, 2));

if (!fs.existsSync(ACTIVE_CHANNELS_FILE)) fs.writeFileSync(ACTIVE_CHANNELS_FILE, JSON.stringify({}, null, 2));

function loadData() {
    const data = JSON.parse(fs.readFileSync(DATA_FILE));
    return { trustedUsers: data.trustedUsers, blacklist: data.blacklist };
}

function saveData(trustedUsers, blacklist) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ trustedUsers, blacklist }, null, 2));
}

function loadActiveChannels() {
    return JSON.parse(fs.readFileSync(ACTIVE_CHANNELS_FILE));
}

function saveActiveChannels(activeChannels) {
    fs.writeFileSync(ACTIVE_CHANNELS_FILE, JSON.stringify(activeChannels, null, 2));
}

const { trustedUsers, blacklist } = loadData();
const activeChannels = new Map(Object.entries(loadActiveChannels()));
const embedMessages = new Map(); // Track active embed messages

async function logEvent(guild, channelId, logMessage, ownerId, channelName) {
    const logsChannel = guild.channels.cache.get(VC_LOG_CHANNEL_ID);
    const embedMessage = embedMessages.get(channelId);

    if (logsChannel && embedMessage) {
        // Edit existing embed
        const existingEmbed = embedMessage.embeds[0];
        const embed = EmbedBuilder.from(existingEmbed)
            .setFields(
                { name: "Activity Log", value: `${existingEmbed.fields.find(f => f.name === "Activity Log")?.value || ''}\n${logMessage}` },
                { name: "Remember to add users to your trusted list!", value: "/addtrusted /viewtrusted /removetrusted", inline: false }
            );
        await embedMessage.edit({ embeds: [embed] });
    } else if (logsChannel) {
        // Create new embed
        const embed = new EmbedBuilder()
            .setAuthor({ name: `Private Call created on ${new Date().toLocaleString('en-US', { month: 'short', day: '2-digit' })}` })
            .setTitle(channelName)
            .addFields(
                { name: "Activity Log", value: logMessage || "[Time in 24h] - [User] [Action]" },
                { name: "Remember to add users to your trusted list!", value: "/addtrusted /viewtrusted /removetrusted", inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Channel ID: ${channelId}` });
        const message = await logsChannel.send({ content: `<@${ownerId}>`, embeds: [embed] });
        embedMessages.set(channelId, message);
    }

    const logFile = path.join(LOGS_DIRECTORY, `${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${logMessage}\n`);
}

async function updateChannelPermissions(channel, ownerId) {
    const permissions = [
        {
            id: channel.guild.roles.everyone.id,
            deny: [PermissionsBitField.Flags.Connect]
        },
        {
            id: ownerId,
            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.MoveMembers,
                PermissionsBitField.Flags.MuteMembers
            ]
        }
    ];

    if (trustedUsers[ownerId]) {
        trustedUsers[ownerId].forEach(userId => {
            permissions.push({
                id: userId,
                allow: [PermissionsBitField.Flags.Connect]
            });
        });
    }

    await channel.permissionOverwrites.set(permissions);

    // Remove users no longer trusted from the channel
    channel.members.forEach(member => {
        if (member.id !== ownerId && (!trustedUsers[ownerId] || !trustedUsers[ownerId].includes(member.id))) {
            member.voice.disconnect();
        }
    });
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.channelId === HUB_CHANNEL_ID) {
        const guild = newState.guild;
        const member = newState.member;
        const hubChannel = guild.channels.cache.get(HUB_CHANNEL_ID);

        if (!hubChannel) {
            console.error("Hub channel not found.");
            return;
        }

        const category = hubChannel.parent;
        const channelName = `${member.displayName}'s Private Call`;

        try {
            const privateChannel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildVoice,
                parent: category.id,
                permissionOverwrites: [] // Permissions will be set after channel creation
            });

            await updateChannelPermissions(privateChannel, member.id);

            activeChannels.set(privateChannel.id, {
                ownerId: member.id,
                timeout: Date.now() + EMPTY_CHANNEL_TIMEOUT
            });
            saveActiveChannels(Object.fromEntries(activeChannels));

            await logEvent(guild, privateChannel.id, "Channel Created", member.id, privateChannel.name);

            await member.voice.setChannel(privateChannel);

        } catch (error) {
            console.error("Error creating private voice channel:", error);
        }
    }
});

async function checkEmptyChannels() {
    for (const [channelId, { ownerId, timeout }] of activeChannels) {
        let channel = client.channels.cache.get(channelId);
        if (!channel) {
            try {
                channel = await client.channels.fetch(channelId);
            } catch (error) {
                if (error.code === 10003) { // Unknown Channel
                    console.log(`Channel ${channelId} has been manually deleted.`);
                    const logMessage = `Channel Deleted - Staff`;
                    const guild = await client.guilds.fetch(GUILD_ID);

                    await logEvent(guild, channelId, logMessage, ownerId, `Deleted Channel`);
                    activeChannels.delete(channelId);
                    saveActiveChannels(Object.fromEntries(activeChannels));
                    embedMessages.delete(channelId); // Remove embed tracking
                } else {
                    console.error(`Error fetching channel ${channelId}:`, error);
                }
                continue;
            }
        }

        if (channel && channel.members.size === 0) {
            if (Date.now() >= timeout) {
                try {
                    const logMessage = `Channel Deleted - Timeout`;

                    await channel.delete();
                    await logEvent(channel.guild, channelId, logMessage, ownerId, channel.name);
                } catch (error) {
                    console.error(`Failed to delete empty channel ${channelId}:`, error.message);
                }

                activeChannels.delete(channelId);
                saveActiveChannels(Object.fromEntries(activeChannels));
                embedMessages.delete(channelId); // Remove embed tracking
            }
        } else if (channel) {
            activeChannels.set(channelId, { ownerId, timeout: Date.now() + EMPTY_CHANNEL_TIMEOUT });
            saveActiveChannels(Object.fromEntries(activeChannels));
        }
    }
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    setInterval(checkEmptyChannels, 60000);

    client.user.setActivity("Lofi Girl", { type: ActivityType.Listening });

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

    try {
        console.log('Started clearing old application (/) commands.');

        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: [] }
        );

        console.log('Cleared old application (/) commands.');

        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: [
                {
                    name: 'addtrusted',
                    description: 'Add a trusted user to your private channel',
                    options: [
                        {
                            name: 'user',
                            description: 'The user to add to your trusted list',
                            type: 6,
                            required: true
                        }
                    ]
                },
                {
                    name: 'removetrusted',
                    description: 'Remove a trusted user from your private channel',
                    options: [
                        {
                            name: 'user',
                            description: 'The user to remove from your trusted list',
                            type: 6,
                            required: true
                        }
                    ]
                },
                {
                    name: 'viewtrusted',
                    description: 'View your trusted user list'
                },
                {
                    name: 'addblacklist',
                    description: 'Add a user to the blacklist',
                    options: [
                        {
                            name: 'user',
                            description: 'The user to add to the blacklist',
                            type: 6,
                            required: true
                        }
                    ]
                },
                {
                    name: 'removeblacklist',
                    description: 'Remove a user from the blacklist',
                    options: [
                        {
                            name: 'user',
                            description: 'The user to remove from the blacklist',
                            type: 6,
                            required: true
                        }
                    ]
                },
                {
                    name: 'viewblacklist',
                    description: 'View the blacklist'
                },
                {
                    name: 'channelstatus',
                    description: 'Set the status of your private channel',
                    options: [
                        {
                            name: 'status',
                            description: 'The status to set (Open, Friends, Closed)',
                            type: 3,
                            required: true,
                            choices: [
                                { name: 'Open', value: 'Open' },
                                { name: 'Friends', value: 'Friends' },
                                { name: 'Closed', value: 'Closed' }
                            ]
                        }
                    ]
                }
            ] }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'addtrusted') {
        const user = options.getUser('user');
        const ownerId = interaction.user.id; // User managing their own trusted list

        if (!trustedUsers[ownerId]) {
            trustedUsers[ownerId] = [];
        }

        if (!trustedUsers[ownerId].includes(user.id)) {
            trustedUsers[ownerId].push(user.id);
            saveData(trustedUsers, blacklist);

            for (const [channelId, data] of activeChannels) {
                if (data.ownerId === ownerId) {
                    const channel = client.channels.cache.get(channelId);
                    if (channel) await updateChannelPermissions(channel, ownerId);
                }
            }

            return interaction.reply({ content: `${user.username} has been added to your trusted list.`, ephemeral: true });
        } else {
            return interaction.reply({ content: `${user.username} is already in your trusted list.`, ephemeral: true });
        }
    }

    if (commandName === 'removetrusted') {
        const user = options.getUser('user');
        const ownerId = interaction.user.id;

        if (trustedUsers[ownerId]?.includes(user.id)) {
            trustedUsers[ownerId] = trustedUsers[ownerId].filter(id => id !== user.id);
            saveData(trustedUsers, blacklist);

            for (const [channelId, data] of activeChannels) {
                if (data.ownerId === ownerId) {
                    const channel = client.channels.cache.get(channelId);
                    if (channel) {
                        await updateChannelPermissions(channel, ownerId);

                        if (channel.members.has(user.id)) {
                            const member = channel.members.get(user.id);
                            await member.voice.disconnect();
                        }
                    }
                }
            }

            return interaction.reply({ content: `${user.username} has been removed from your trusted list.`, ephemeral: true });
        } else {
            return interaction.reply({ content: `${user.username} is not in your trusted list.`, ephemeral: true });
        }
    }

    if (commandName === 'viewtrusted') {
        const ownerId = interaction.user.id;
        const trusted = trustedUsers[ownerId]?.map(id => `<@${id}>`).join(', ') || 'None';
        return interaction.reply({ content: `Your trusted users: ${trusted}`, ephemeral: true });
    }
});

client.login(BOT_TOKEN);
