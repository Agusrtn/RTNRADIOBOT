require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState, VoiceConnectionStatus } = require('@discordjs/voice');

const { createSongPoller } = require('./songUpdater');

const RADIO_STREAM_URL = process.env.RADIO_STREAM_URL;
const RADIO_STREAM_USER_AGENT = process.env.RADIO_STREAM_USER_AGENT;
const RADIO_CURRENT_SONG_ENDPOINT = process.env.RADIO_CURRENT_SONG_ENDPOINT || 'https://rtnmusicappbackend.onrender.com/radio';
const SONG_POLL_MS = Number(process.env.SONG_POLL_MS || 2000);

if (!process.env.DISCORD_TOKEN) {
  throw new Error('Missing DISCORD_TOKEN in .env');
}
if (!RADIO_STREAM_URL) {
  throw new Error('Missing RADIO_STREAM_URL in .env (direct audio stream URL)');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer();

let currentSongMessage = null;
let currentSongMessageChannel = null;
let songPoller = null;
let lastSong = null;

function getNextUserVoiceChannel(interaction) {
  const member = interaction.member;
  if (!member || !member.voice || !member.voice.channel) return null;
  return member.voice.channel;
}

async function ensureConnected(voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (e) {
    connection.destroy();
    throw e;
  }

  return connection;
}

player.on(AudioPlayerStatus.Playing, () => {
  // console.log('Now playing');
});

player.on('error', (err) => {
  // console.error('Audio player error:', err);
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const voiceChannel = getNextUserVoiceChannel(interaction);
  if (!voiceChannel) {
    return interaction.reply({ content: 'Entra a un canal de voz para usar este comando.', ephemeral: true });
  }

  if (interaction.commandName === 'play') {
    await interaction.deferReply();
    try {
      const connection = await ensureConnected(voiceChannel);
      connection.subscribe(player);

      const resourceOptions = {};
      if (RADIO_STREAM_USER_AGENT) {
        resourceOptions.inputArgs = ['-headers', `User-Agent: ${RADIO_STREAM_USER_AGENT}\r\n`];
      }

      const resource = createAudioResource(RADIO_STREAM_URL, resourceOptions);
      player.play(resource);

      // Poll CURRENT SONG every SONG_POLL_MS and only update when it changes.
      if (!songPoller) {
        songPoller = createSongPoller({
          endpoint: RADIO_CURRENT_SONG_ENDPOINT,
          pollMs: SONG_POLL_MS,
          onSongChange: async (song) => {
            if (!song || song === lastSong) return;
            lastSong = song;

            const textChannel = interaction.channel;
            const content = `🎵 **Current song:** ${song}`;

            try {
              if (currentSongMessage && currentSongMessageChannel?.id === textChannel?.id) {
                await currentSongMessage.edit({ content });
              } else {
                currentSongMessageChannel = textChannel;
                currentSongMessage = await textChannel.send({ content });
              }
            } catch {
              // Avoid crashing if Discord edit/send fails.
            }
          },
          onError: () => {
            // Keep polling.
          },
        });

        songPoller.start();
      }

      return interaction.editReply({ content: `Reproduciendo radio en: **${voiceChannel.name}**` });
    } catch (e) {
      return interaction.editReply({ content: `No pude iniciar la reproducción. Revisa RADIO_STREAM_URL. Error: ${e?.message || e}` });
    }
  }

  if (interaction.commandName === 'stop') {
    await interaction.deferReply();

    try {
      player.stop(true);

      if (songPoller) {
        songPoller.stop();
        songPoller = null;
      }
      lastSong = null;

      return interaction.editReply({ content: 'Radio detenida.' });
    } catch (e) {
      return interaction.editReply({ content: `Error deteniendo: ${e?.message || e}` });
    }
  }
});

// Register commands programmatically (simple, best-effort)
async function registerCommands() {
  const { REST, Routes } = require('discord.js');
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!clientId) return;

  const rest = new REST({ version: '10' }).setToken(token);

  const commands = [
    {
      name: 'play',
      description: 'Reproduce la radio en tu canal de voz',
    },
    {
      name: 'stop',
      description: 'Detiene la radio',
    },
  ];

  // Global commands
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('Commands registered');
}

registerCommands().catch((e) => console.warn('Command registration skipped/failed:', e?.message || e));

client.login(process.env.DISCORD_TOKEN);

