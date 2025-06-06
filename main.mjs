import fetch from 'node-fetch';
import { Client, IntentsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const CRCON_SERVER = process.env.CRCON_SERVER;
const CRCON_API_KEY = process.env.CRCON_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

if (!CRCON_API_KEY || !DISCORD_TOKEN || !CHANNEL_ID) {
  throw new Error('Missing environment variables: CRCON_API_KEY, DISCORD_TOKEN, and CHANNEL_ID are required');
}

const MAPS_FILE_PATH = path.join(process.cwd(), 'maps.selection.json');
let MAPS;
async function loadMaps() {
  try {
    const data = await fs.readFile(MAPS_FILE_PATH, 'utf8');
    MAPS = JSON.parse(data).result;
    console.log('maps.selection.json loaded successfully');
  } catch (error) {
    console.error('Error loading maps.selection.json:', error.message);
    throw error;
  }
}

await loadMaps();

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});

let botMessageId = null;
let currentVotemapConfig = null;
let selectedMapId = null;
let mapCheckInterval = null;

async function getVotemapConfig() {
  const start = Date.now();
  try {
    const response = await fetch(`${CRCON_SERVER}/api/get_votemap_config`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CRCON_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    const data = await response.json();
    if (data.failed) throw new Error(`API error: ${data.error}`);
    console.log(`getVotemapConfig completed in ${Date.now() - start}ms`);
    return data.result;
  } catch (error) {
    console.error(`getVotemapConfig failed after ${Date.now() - start}ms:`, error.message);
    throw error;
  }
}

async function setVotemapConfig(config, by = 'DiscordBot') {
  const start = Date.now();
  try {
    const response = await fetch(`${CRCON_SERVER}/api/set_votemap_config`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CRCON_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        by,
        config,
        reset_to_default: false,
      }),
    });
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    const data = await response.json();
    if (data.failed) throw new Error(`API error: ${data.error}`);
    console.log(`setVotemapConfig completed in ${Date.now() - start}ms, response:`, data);
    return data.result;
  } catch (error) {
    console.error(`setVotemapConfig failed after ${Date.now() - start}ms:`, error.message);
    throw error;
  }
}

async function setMapRotation(mapNames) {
  const start = Date.now();
  try {
    const response = await fetch(`${CRCON_SERVER}/api/set_maprotation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CRCON_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ map_names: mapNames }),
    });
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    const data = await response.json();
    if (data.failed) throw new Error(`API error: ${data.error}`);
    console.log(`setMapRotation completed in ${Date.now() - start}ms`);
    return data.result;
  } catch (error) {
    console.error(`setMapRotation failed after ${Date.now() - start}ms:`, error.message);
    throw error;
  }
}

async function getCurrentMap() {
  const start = Date.now();
  try {
    const response = await fetch(`${CRCON_SERVER}/api/get_map`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CRCON_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    const data = await response.json();
    if (data.failed) throw new Error(`API error: ${data.error}`);
    console.log(`getCurrentMap completed in ${Date.now() - start}ms`);
    return data.result;
  } catch (error) {
    console.error(`getCurrentMap failed after ${Date.now() - start}ms:`, error.message);
    throw error;
  }
}

async function sendWebhookMessage(mapName, user) {
  if (!DISCORD_WEBHOOK) {
    console.warn('DISCORD_WEBHOOK not set, skipping webhook notification');
    return;
  }

  try {
    const embed = {
      title: 'Map Selection',
      color: 0x0099ff,
      fields: [
        { name: 'Selected Map', value: mapName, inline: true },
        { name: 'Selected By', value: user, inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        embeds: [embed],
      }),
    });

    if (!response.ok) throw new Error(`Webhook error: ${response.status}`);
    console.log('Webhook message sent successfully');
  } catch (error) {
    console.error('Error sending webhook message:', error.message);
  }
}

async function checkMapAndReenable(channel) {
  if (!selectedMapId) return;
  try {
    const currentMap = await getCurrentMap();
    if (currentMap.id === selectedMapId) {
      console.log('Selected map matches current map, re-enabling votemap...');

      const serverConfig = await getVotemapConfig();
      const enableConfig = { ...serverConfig, enabled: true };
      console.log('Config to re-enable votemap:', enableConfig);

      await setVotemapConfig(enableConfig, 'DiscordBot');
      console.log('Votemap re-enable request sent');

      console.log('Verifying votemap is re-enabled...');
      let updatedConfig = null;
      let attempts = 0;
      const maxAttempts = 3;
      const delayMs = 500;

      while (attempts < maxAttempts) {
        attempts++;
        updatedConfig = await getVotemapConfig();
        console.log(`Verification attempt ${attempts}:`, updatedConfig.enabled);

        if (updatedConfig.enabled) {
          break;
        }

        if (attempts < maxAttempts) {
          console.log(`Votemap still disabled, retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      if (!updatedConfig.enabled) {
        throw new Error('Failed to automatically re-enable votemap after multiple attempts.');
      }

      currentVotemapConfig = updatedConfig;
      selectedMapId = null;
      clearInterval(mapCheckInterval);
      mapCheckInterval = null;
      await updateEmbedAndButtons(channel);
      console.log('Votemap automatically re-enabled as selected map is active');
    }
  } catch (error) {
    console.error('Error checking current map or re-enabling votemap:', error.message);
  }
}

async function updateEmbedAndButtons(channel) {
  try {
    const embed = new EmbedBuilder()
      .setTitle('Votemap Control')
      .setColor('#0099ff')
      .setTimestamp();

    let statusMessage = currentVotemapConfig?.enabled ? 'Votemap: Enabled' : 'Votemap: Disabled';
    if (!currentVotemapConfig) {
      statusMessage = '⚠️ Warning: Votemap configuration unavailable';
      embed.setColor('#ff0000');
    }

    const selectedMap = selectedMapId ? MAPS.find(map => map.id === selectedMapId)?.pretty_name : 'None';
    const tasks = selectedMapId ? `Waiting for map change to: ${selectedMap}` : 'No active tasks';

    embed.addFields(
      { name: 'Status', value: statusMessage },
      { name: 'Selected Map', value: selectedMap },
      { name: 'Current Tasks', value: tasks }
    );

    const enableButton = new ButtonBuilder()
      .setCustomId('enable_votemap')
      .setLabel('Enable')
      .setStyle(ButtonStyle.Success)
      .setDisabled(currentVotemapConfig?.enabled);

    const disableButton = new ButtonBuilder()
      .setCustomId('disable_votemap')
      .setLabel('Disable')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!currentVotemapConfig?.enabled);

    const searchButton = new ButtonBuilder()
      .setCustomId('search_map')
      .setLabel('Search Map')
      .setStyle(ButtonStyle.Secondary);

    const row1 = new ActionRowBuilder().addComponents(enableButton, disableButton);
    const row2 = new ActionRowBuilder().addComponents(searchButton);

    const message = await channel.messages.fetch(botMessageId);
    await message.edit({ embeds: [embed], components: [row1, row2] });
    console.log('Embed and buttons updated');
  } catch (error) {
    console.error('Error updating embed and buttons:', error.message);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    currentVotemapConfig = await getVotemapConfig();
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel.isTextBased()) throw new Error('Channel is not a text channel');

    await channel.bulkDelete(await channel.messages.fetch({ limit: 100 }), true);
    const embed = new EmbedBuilder()
      .setTitle('Map Manager')
      .setColor('#0099ff')
      .setTimestamp()
      .addFields(
        { name: 'Status', value: currentVotemapConfig.enabled ? 'Votemap: Enabled' : 'Votemap: Disabled' },
        { name: 'Selected Map', value: 'None' },
        { name: 'Current Tasks', value: 'No active tasks' }
      );

    const enableButton = new ButtonBuilder()
      .setCustomId('enable_votemap')
      .setLabel('Enable')
      .setStyle(ButtonStyle.Success)
      .setDisabled(currentVotemapConfig.enabled);

    const disableButton = new ButtonBuilder()
      .setCustomId('disable_votemap')
      .setLabel('Disable')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!currentVotemapConfig.enabled);

    const searchButton = new ButtonBuilder()
      .setCustomId('search_map')
      .setLabel('Search Map')
      .setStyle(ButtonStyle.Secondary);

    const row1 = new ActionRowBuilder().addComponents(enableButton, disableButton);
    const row2 = new ActionRowBuilder().addComponents(searchButton);

    const sentMessage = await channel.send({ embeds: [embed], components: [row1, row2] });
    botMessageId = sentMessage.id;
    console.log('Embed sent, message ID:', botMessageId);
  } catch (error) {
    console.error('Error during setup:', error.message);
    process.exit(1);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.message.id !== botMessageId && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) return;

  const channel = interaction.channel;

  if (interaction.isButton()) {
    try {
      switch (interaction.customId) {
        case 'enable_votemap':
          console.log('Enable button pressed at', new Date().toISOString());
          await interaction.deferReply({ flags: 64 });
          console.log('Interaction deferred');

          try {
            console.log('Fetching current votemap config...');
            const serverConfig = await getVotemapConfig();
            console.log('Server votemap config:', serverConfig);

            if (serverConfig.enabled) {
              console.log('Votemap is already enabled on the server');
              currentVotemapConfig.enabled = true;
              await updateEmbedAndButtons(channel);
              await interaction.editReply({ content: 'Votemap is already enabled!' });
              return;
            }

            const enableConfig = { ...serverConfig, enabled: true };
            console.log('Config to enable votemap:', enableConfig);

            console.log('Enabling votemap...');
            const setResponse = await setVotemapConfig(enableConfig);
            console.log('Votemap enable request sent, response:', setResponse);

            console.log('Verifying votemap is enabled...');
            let updatedConfig = null;
            let attempts = 0;
            const maxAttempts = 3;
            const delayMs = 500;

            while (attempts < maxAttempts) {
              attempts++;
              updatedConfig = await getVotemapConfig();
              console.log(`Verification attempt ${attempts}:`, updatedConfig.enabled);

              if (updatedConfig.enabled) {
                break;
              }

              if (attempts < maxAttempts) {
                console.log(`Votemap still disabled, retrying in ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
              }
            }

            if (!updatedConfig.enabled) {
              throw new Error('Failed to enable votemap after multiple attempts. Please try again.');
            }

            currentVotemapConfig.enabled = true;
            console.log('Votemap successfully enabled and verified');

            console.log('Updating embed...');
            await updateEmbedAndButtons(channel);
            console.log('Embed updated');

            await interaction.editReply({ content: 'Votemap enabled!' });
          } catch (error) {
            console.error('Error in enable_votemap:', error.message, error.stack);
            await interaction.editReply({ content: `Error: ${error.message}` });
          }
          break;

        case 'disable_votemap':
          console.log('Disable button pressed at', new Date().toISOString());
          await interaction.deferReply({ flags: 64 });
          console.log('Interaction deferred');

          try {
            console.log('Fetching current votemap config...');
            const serverConfig = await getVotemapConfig();
            console.log('Server votemap config:', serverConfig);

            if (!serverConfig.enabled) {
              console.log('Votemap is already disabled on the server');
              currentVotemapConfig.enabled = false;
              await updateEmbedAndButtons(channel);
              await interaction.editReply({ content: 'Votemap is already disabled!' });
              return;
            }

            const disableConfig = { ...serverConfig, enabled: false };
            console.log('Config to disable votemap:', disableConfig);

            console.log('Disabling votemap...');
            const setResponse = await setVotemapConfig(disableConfig);
            console.log('Votemap disable request sent, response:', setResponse);

            console.log('Verifying votemap is disabled...');
            let updatedConfig = null;
            let attempts = 0;
            const maxAttempts = 3;
            const delayMs = 500;

            while (attempts < maxAttempts) {
              attempts++;
              updatedConfig = await getVotemapConfig();
              console.log(`Verification attempt ${attempts}:`, updatedConfig.enabled);

              if (!updatedConfig.enabled) {
                break;
              }

              if (attempts < maxAttempts) {
                console.log(`Votemap still enabled, retrying in ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
              }
            }

            if (updatedConfig.enabled) {
              throw new Error('Failed to disable votemap after multiple attempts. Please try again.');
            }

            currentVotemapConfig.enabled = false;
            console.log('Votemap successfully disabled and verified');

            console.log('Updating embed...');
            await updateEmbedAndButtons(channel);
            console.log('Embed updated');

            await interaction.editReply({ content: 'Votemap disabled!' });
          } catch (error) {
            console.error('Error in disable_votemap:', error.message, error.stack);
            await interaction.editReply({ content: `Error: ${error.message}` });
          }
          break;

        case 'search_map':
          const searchModal = new ModalBuilder()
            .setCustomId('map_search_modal')
            .setTitle('Search Map');
          const searchInput = new TextInputBuilder()
            .setCustomId('map_search_input')
            .setLabel('Enter map name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
          searchModal.addComponents(new ActionRowBuilder().addComponents(searchInput));
          await interaction.showModal(searchModal);
          break;
      }
    } catch (error) {
      console.error(`Error with button ${interaction.customId}:`, error.message);
      if (interaction.deferred) {
        await interaction.editReply({ content: `Error: ${error.message}` });
      } else {
        await interaction.reply({ content: `Error: ${error.message}`, flags: 64 });
      }
    }
  } else if (interaction.isModalSubmit()) {
    try {
      if (interaction.customId === 'map_search_modal') {
        const searchQuery = interaction.fields.getTextInputValue('map_search_input').toLowerCase();
        const results = MAPS.filter(map => map.pretty_name.toLowerCase().includes(searchQuery));

        if (results.length === 0) {
          await interaction.reply({ content: 'No maps found!', flags: 64 });
          return;
        }

        const options = results.slice(0, 25).map(map => ({
          label: map.pretty_name,
          value: map.id,
        }));

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('map_select')
          .setPlaceholder('Select a map')
          .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({
          content: `Found maps (${results.length}):`,
          components: [row],
          flags: 64,
        });
      }
    } catch (error) {
      console.error('Error with modal:', error.message);
      await interaction.reply({ content: `Error: ${error.message}`, flags: 64 });
    }
  } else if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === 'map_select') {
        console.log('Map selected at', new Date().toISOString());
        await interaction.deferReply({ flags: 64 });
        console.log('Interaction deferred');

        try {
          selectedMapId = interaction.values[0];
          const mapName = MAPS.find(map => map.id === selectedMapId).pretty_name;
          const user = interaction.user.tag;
          console.log('Selected Map ID:', selectedMapId, 'Name:', mapName, 'User:', user);

          console.log('Sending initial reply...');
          await interaction.editReply({ content: `Map "${mapName}" is being selected and votemap is being disabled... Please wait.` });
          console.log('Initial reply sent');

          console.log('Sending webhook message...');
          await sendWebhookMessage(mapName, user);
          console.log('Webhook message sent');

          console.log('Disabling votemap...');
          const serverConfig = await getVotemapConfig();
          const disableConfig = { ...serverConfig, enabled: false };
          await setVotemapConfig(disableConfig);
          console.log('Votemap disable request sent');

          console.log('Verifying votemap is disabled...');
          let updatedConfig = null;
          let attempts = 0;
          const maxAttempts = 3;
          const delayMs = 500;

          while (attempts < maxAttempts) {
            attempts++;
            updatedConfig = await getVotemapConfig();
            console.log(`Verification attempt ${attempts}:`, updatedConfig.enabled);

            if (!updatedConfig.enabled) {
              break;
            }

            if (attempts < maxAttempts) {
              console.log(`Votemap still enabled, retrying in ${delayMs}ms...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
          }

          if (updatedConfig.enabled) {
            throw new Error('Failed to disable votemap after multiple attempts. Please try again.');
          }

          currentVotemapConfig.enabled = false;
          console.log('Votemap successfully disabled and verified');

          console.log('Setting map rotation...');
          await setMapRotation([selectedMapId]);
          console.log('Map rotation set');

          console.log('Starting map check interval...');
          mapCheckInterval = setInterval(() => checkMapAndReenable(channel), 15 * 1000);

          console.log('Updating embed...');
          await updateEmbedAndButtons(channel);
          console.log('Embed updated');

          console.log('Sending final reply...');
          await interaction.followUp({ content: `Map "${mapName}" selected and votemap disabled!`, flags: 64 });
          console.log('Final reply sent');
        } catch (error) {
          console.error('Error in map_select:', error.message, error.stack);
          await interaction.followUp({ content: `Error: ${error.message}`, flags: 64 });
        }
      }
    } catch (error) {
      console.error('Error with dropdown:', error.message);
      await interaction.reply({ content: `Error: ${error.message}`, flags: 64 });
    }
  }
});

client.login(DISCORD_TOKEN).catch(error => {
  console.error('Login failed:', error.message);
  process.exit(1);
});
