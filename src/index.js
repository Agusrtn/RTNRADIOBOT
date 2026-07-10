require('dotenv').config();

const http = require('http');

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

const { createSongPoller } = require('./songUpdater');

const RADIO_STREAM_URL = process.env.RADIO_STREAM_URL;
const RADIO_STREAM_USER_AGENT = process.env.RADIO_STREAM_USER_AGENT;
const RADIO_CURRENT_SONG_ENDPOINT = process.env.RADIO_CURRENT_SONG_ENDPOINT || 'https://rtnmusicappbackend.onrender.com/radio';
const RADIO_PLAYBACK_URL_OVERRIDE = process.env.RADIO_PLAYBACK_URL_OVERRIDE;
const RADIO_AUDIO_BASE_URL = process.env.RADIO_AUDIO_BASE_URL;
const SONG_POLL_MS = Number(process.env.SONG_POLL_MS || 2000);

if (!process.env.DISCORD_TOKEN) {
  throw new Error('Missing DISCORD_TOKEN in .env');
}
if (!RADIO_STREAM_URL) {
  throw new Error('Missing RADIO_STREAM_URL in .env (direct audio stream URL)');
}

// Render “Web Service” health/port binding
// Your Discord bot does not need HTTP, but Render requires a bound port for Web Service.
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/' || req.url === undefined) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('OK');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer();

let currentSongMessage = null;
let currentSongMessageChannel = null;
let songPoller = null;
let lastSong = null;
let currentVoiceChannel = null;
let currentVoiceConnection = null;
let currentPlayingUrl = null;

// small helper
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

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
    console.log(`[voice] connected to ${voiceChannel.name} (${voiceChannel.id}) in guild ${voiceChannel.guild.id}`);
    connection.on(VoiceConnectionStatus.Disconnected, (oldState, newState) => {
      console.warn('[voice] connection disconnected, attempting recovery');
    });
  } catch (e) {
    console.error('[voice] ensureConnected failed:', e?.message || e, e?.stack || 'no stack');
    connection.destroy();
    throw e;
  }

  return connection;
}

function setCurrentConnection(connection, voiceChannel) {
  currentVoiceConnection = connection;
  currentVoiceChannel = voiceChannel;
}

player.on(AudioPlayerStatus.Playing, () => {
  console.log('[player] status: Playing');
});
player.on(AudioPlayerStatus.Idle, () => {
  console.log('[player] status: Idle');
});

player.on(AudioPlayerStatus.Buffering, () => {
  console.log('[player] status: Buffering');
});

player.on(AudioPlayerStatus.Paused, () => {
  console.log('[player] status: Paused');
});

player.on('error', (err) => {
  console.error('[player] error:', err?.message || err, err?.stack || 'no stack');
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
    setCurrentConnection(connection, voiceChannel);

      const resourceOptions = {
        inlineVolume: true,
      };

      if (RADIO_STREAM_USER_AGENT) {
        resourceOptions.inputArgs = ['-headers', `User-Agent: ${RADIO_STREAM_USER_AGENT}\r\n`];
      }

      const streamUrl = (() => {
        try {
          // Test for Render: forzamos un mp3 directo si existe.
          const testMp3 = process.env.RADIO_TEST_MP3_URL;
          if (testMp3) return testMp3;

          const override = RADIO_PLAYBACK_URL_OVERRIDE;
          if (override) return override;

          const s = songPoller?.getLastSongObject?.();

          // Preferimos audioUrl del endpoint /radio (cambia por canción).
          // Si el campo no existe, usamos fallback.
          return (
            s?.audioUrl ||
            s?.audio_url ||
            s?.url ||
            s?.streamUrl ||
            RADIO_STREAM_URL
          );
        } catch {
          return RADIO_STREAM_URL;
        }
      })();

      console.log('[play] using streamUrl:', streamUrl);
      console.log('[play] streamResourceOptions:', streamResourceOptions);

      // Reintentos/reconexión ayudan cuando el stream corta o responde mal al inicio.
      const streamResourceOptions = {
        ...resourceOptions,
        inputArgs: [
          ...(resourceOptions.inputArgs || []),
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
        ],
      };

      try {
        const resource = createAudioResource(streamUrl, streamResourceOptions);
        player.play(resource);
        currentPlayingUrl = streamUrl;
      } catch (e) {
        console.error('[play] createAudioResource/play failed for', streamUrl, e?.message || e);
        throw e;
      }

      // Poll CURRENT SONG every SONG_POLL_MS and only update when it changes.
      if (!songPoller) {
        songPoller = createSongPoller({
          endpoint: RADIO_CURRENT_SONG_ENDPOINT,
          pollMs: SONG_POLL_MS,
          onSongChange: async (info) => {
            console.log('[songPoller] onSongChange:', info);
            // info: { title, audioUrl, object }
            if (!info) return;

            // Build a readable title
            const title = info.title || info.object?.title || info.object?.song || info.object?.name || String(info.object || '');

            // Update presence
            try {
              if (client.user && title) {
                client.user.setPresence({ activities: [{ name: title, type: ActivityType.Listening }], status: 'online' });
                console.log('[presence] set to:', title);
              }
            } catch (e) {
              console.warn('[presence] setPresence failed', e?.message || e);
            }

            // Update text channel message
            try {
              const textChannel = interaction.channel;
              const content = `🎵 **Current song:** ${title}`;

              if (currentSongMessage && currentSongMessageChannel?.id === textChannel?.id) {
                await currentSongMessage.edit({ content });
              } else {
                currentSongMessageChannel = textChannel;
                currentSongMessage = await textChannel.send({ content });
              }
            } catch (e) {
              console.warn('[songPoller] update message failed', e?.message || e);
            }

            // If the backend provided an audio URL and it's different, switch playback
            try {
              const url = info.audioUrl || info.object?.audioUrl || info.object?.audio_url || info.object?.url || info.object?.streamUrl || null;
              console.log('[songPoller] detected audioUrl:', url, 'currentPlayingUrl:', currentPlayingUrl);
              if (url && url !== currentPlayingUrl) {
                try {
                  const newRes = createAudioResource(url, streamResourceOptions);
                  player.play(newRes);
                  currentPlayingUrl = url;
                  console.log('[play] switched to new audioUrl');
                } catch (e) {
                  console.error('[play] failed switching to new audioUrl', e?.message || e);
                }
              }
            } catch (e) {
              console.warn('[songPoller] playback switch check failed', e?.message || e);
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

// If the bot is removed from the voice channel, try to rejoin it.
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (!oldState || !oldState.member) return;
    if (oldState.member.id !== client.user.id) return;

    // Bot was in a channel and now is not -> try to rejoin
    if (oldState.channel && !newState.channel) {
      const voiceChannel = oldState.channel;
      // Try a few times with exponential backoff
      const maxAttempts = 4;
      let attempt = 0;
      while (attempt < maxAttempts) {
        attempt += 1;
        try {
          console.log('[voiceStateUpdate] attempt', attempt, 'to rejoin', voiceChannel.name);
          const connection = await ensureConnected(voiceChannel);
          connection.subscribe(player);
          setCurrentConnection(connection, voiceChannel);
          console.log('[voiceStateUpdate] rejoin successful on attempt', attempt);
          break;
        } catch (e) {
          console.warn('[voiceStateUpdate] rejoin attempt', attempt, 'failed:', e?.message || e);
          console.warn(e?.stack || 'no stack');
          if (attempt >= maxAttempts) {
            console.error('[voiceStateUpdate] all rejoin attempts failed');
            break;
          }
          // backoff: 2s, 4s, 8s...
          const wait = 2000 * Math.pow(2, attempt - 1);
          console.log('[voiceStateUpdate] waiting', wait, 'ms before next attempt');
          // eslint-disable-next-line no-await-in-loop
          await sleep(wait);
        }
      }
    }
  } catch (e) {
    console.error('[voiceStateUpdate] unexpected error', e?.message || e, e?.stack || 'no stack');
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

