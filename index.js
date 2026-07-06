require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  extractMessageContent
} = require('@fadzzzslebew/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { Readable, PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(require('ffmpeg-static'));

const logger = pino({ level: 'silent' });
const log = (msg) => console.log(`[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${msg}`);

const pendingAudio = new Map();

const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');

async function getWAVersion() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json');
    const { version } = await res.json();
    if (Array.isArray(version)) return version;
  } catch { }
  return [2, 3000, 1035194821];
}

function toOggOpus(inputBuffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const src = new Readable();
    src.push(inputBuffer);
    src.push(null);
    const out = new PassThrough();
    out.on('data', c => chunks.push(c));
    out.on('end', () => resolve(Buffer.concat(chunks)));
    out.on('error', reject);
    ffmpeg(src).audioCodec('libopus').audioFrequency(48000).audioChannels(1).format('ogg').on('error', reject).pipe(out, { end: true });
  });
}

function buildChannelMenu(newsletters) {
  const entries = Object.entries(newsletters);
  if (!entries.length) return null;
  const lines = entries.map(([, meta], i) => `${i + 1}. ${meta.name || 'Unnamed'}`);
  return { entries, text: 'Select target channel:\n\n' + lines.join('\n') + '\n\nReply with a number.' };
}

async function handleAudio(sock, m, from, audioDetails, newsletters) {
  if (OWNER_NUMBER) {
    const sender = from.split('@')[0];
    if (!sender.includes(OWNER_NUMBER)) return;
  }

  const menu = buildChannelMenu(newsletters);
  if (!menu) {
    await sock.sendMessage(from, { text: 'No channels found. Make sure the bot account follows at least one WhatsApp Channel.' }, { quoted: m });
    return;
  }

  log(`AUDIO | from=${from} | mime=${audioDetails.mimetype} | downloading...`);

  let buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reUploadRequest: sock.updateMediaMessage });
  if (!buffer) throw new Error('download failed');

  const mime = audioDetails.mimetype || '';
  if (!mime.includes('ogg') && !mime.includes('opus')) {
    log(`CONVERT | from=${mime} to ogg/opus`);
    buffer = await toOggOpus(buffer);
  }

  pendingAudio.set(from, { buffer, entries: menu.entries, m });
  await sock.readMessages([m.key]);
  await sock.sendMessage(from, { text: menu.text }, { quoted: m });
  log(`PENDING | from=${from} | waiting for channel selection`);
}

async function handleSelection(sock, m, from, text) {
  const pending = pendingAudio.get(from);
  if (!pending) return false;

  const choice = parseInt(text.trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > pending.entries.length) {
    await sock.sendMessage(from, { text: `Invalid selection. Enter a number between 1 and ${pending.entries.length}.` }, { quoted: m });
    return true;
  }

  const [targetJid, targetMeta] = pending.entries[choice - 1];
  pendingAudio.delete(from);

  await sock.sendMessage(targetJid, { audio: pending.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  await sock.readMessages([m.key]);
  await sock.sendMessage(from, { text: `Audio successfully sent to "${targetMeta.name || targetJid}".` }, { quoted: m });
  log(`FORWARD | success | target=${targetJid}`);
  return true;
}

async function startBot() {
  log('BOOT | connecting...');
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
  const version = await getWAVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger,
    browser: ['Bot', 'Chrome', '1.0.0'],
    getMessage: async () => ({ conversation: '' })
  });

  let newsletters = {};

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) log('QR | scan to connect');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      log(`DISCONNECT | code=${code} | loggedOut=${isLoggedOut}`);
      if (isLoggedOut) {
        log('LOGOUT | clearing auth and exiting...');
        fs.rmSync(path.join(__dirname, 'auth_info_baileys'), { recursive: true, force: true });
      }
      process.exit(isLoggedOut ? 0 : 1);
    } else if (connection === 'open') {
      const { name, id } = sock.user;
      log(`CONNECTED | name=${name} | number=${id.split(':')[0]}`);
      try {
        newsletters = await sock.newsletterFetchAllParticipating();
        Object.entries(newsletters).forEach(([jid, meta], i) => log(`CHANNEL ${i + 1} | ${meta.name} | ${jid}`));
      } catch {
        log('WARN | failed to load newsletters');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      const m = messages[0];
      if (!m.message || m.key.fromMe) return;

      const from = m.key.remoteJid;
      const content = extractMessageContent(m.message);
      if (!content) return;

      const contentType = getContentType(content);
      let audioDetails = null;

      if (contentType === 'audioMessage') {
        audioDetails = content.audioMessage;
      } else if (contentType === 'documentMessage' && content.documentMessage.mimetype?.startsWith('audio/')) {
        audioDetails = content.documentMessage;
      }

      if (audioDetails) {
        try {
          await handleAudio(sock, m, from, audioDetails, newsletters);
        } catch (err) {
          log(`ERROR | ${err.message}`);
          pendingAudio.delete(from);
          await sock.readMessages([m.key]);
          await sock.sendMessage(from, { text: `Failed to process audio: ${err.message}` }, { quoted: m });
        }
        return;
      }

      if (contentType === 'conversation' || contentType === 'extendedTextMessage') {
        const text = content.conversation || content.extendedTextMessage?.text || '';
        const handled = await handleSelection(sock, m, from, text);
        if (handled) return;
      }

      await sock.readMessages([m.key]);
      log(`READ | from=${from} | type=${contentType}`);
    } catch (err) {
      log(`ERROR | ${err.message}`);
    }
  });
}

process.title = 'bot-wasaf';

const shutdown = (signal) => {
  log(`SHUTDOWN | received ${signal}`);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => log(`UNCAUGHT | ${err.message}`));
process.on('unhandledRejection', (err) => log(`UNHANDLED | ${err?.message || err}`));

startBot().catch(err => log(`FATAL | ${err.message}`));