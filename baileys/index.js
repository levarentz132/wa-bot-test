import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import axios from 'axios';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const PORT = 3001;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/whatsapp-in';

// Ensure directories exist
const authDir = './auth';
const mediaDir = './media';
[authDir, mediaDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const logger = pino({ level: 'info' });

// Log buffer system for dashboard
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];

// Override console methods to capture logs
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function addToLogBuffer(level, args) {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  ).join(' ');
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };
  
  logBuffer.unshift(logEntry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.pop();
  }
}

console.log = function(...args) {
  addToLogBuffer('info', args);
  originalConsoleLog.apply(console, args);
};

console.error = function(...args) {
  addToLogBuffer('error', args);
  originalConsoleError.apply(console, args);
};

console.warn = function(...args) {
  addToLogBuffer('warn', args);
  originalConsoleWarn.apply(console, args);
};

// Redis client setup
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => {
  console.error('❌ Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('❌ Failed to connect to Redis:', err.message);
  }
})();

// Handover and buffer system
const handoverUsers = {};
const messageBuffer = {};
const HANDOVER_COMMANDS = ['#handover', '#botoff', '/takeover'];
const RESUME_COMMANDS = ['#resume', '#boton', '/resume'];

let sock;
let currentQRCode = null; // Store current QR code for dashboard
let pairingCode = null; // Store pairing code
let lastError = null; // Store last connection error
let lastPhoneNumber = null; // Store phone number for reconnection
let connectionState = {
  connected: false,
  user: null,
  lastQR: null,
  pairingCode: null,
  lastError: null
};

function normalizeUser(jid = '') {
  return jid;
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  ).trim();
}

// Redis helper functions
async function setCache(key, value, expirationSeconds = 3600) {
  try {
    if (redisClient.isOpen) {
      await redisClient.setEx(key, expirationSeconds, JSON.stringify(value));
      return true;
    }
  } catch (err) {
    console.error('Redis SET error:', err.message);
  }
  return false;
}

async function getCache(key) {
  try {
    if (redisClient.isOpen) {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    }
  } catch (err) {
    console.error('Redis GET error:', err.message);
  }
  return null;
}

async function deleteCache(key) {
  try {
    if (redisClient.isOpen) {
      await redisClient.del(key);
      return true;
    }
  } catch (err) {
    console.error('Redis DEL error:', err.message);
  }
  return false;
}

async function connectToWhatsApp(phoneNumber = null) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  
  // Fetch latest Baileys version
  const { version } = await fetchLatestBaileysVersion();
  console.log('📦 Using Baileys version:', version.join('.'));

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
    getMessage: async (key) => {
      console.log('📥 getMessage called for key:', key);
      return { conversation: 'Hi' };
    }
  });

  // Request pairing code if phone number is provided
  if (phoneNumber && !state.creds.registered) {
    lastPhoneNumber = phoneNumber; // Store for reconnection
    console.log('📱 Requesting pairing code for:', phoneNumber);
    try {
      // Wait a bit for socket to be ready
      console.log('⏳ Waiting 3 seconds for socket to initialize...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log('📡 Requesting pairing code from WhatsApp...');
      const code = await sock.requestPairingCode(phoneNumber);
      pairingCode = code;
      connectionState.pairingCode = code;
      console.log('✅ Pairing code generated:', code);
      console.log('⏰ Keeping connection open - waiting for you to enter code on phone...');
      console.log('📱 Steps: WhatsApp → Settings → Linked Devices → Link Device → Enter code');
    } catch (err) {
      console.error('❌ Failed to generate pairing code:', err);
      connectionState.lastError = `Pairing code generation failed: ${err.message}`;
    }
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Log all connection state changes
    if (connection) {
      console.log('🔄 Connection state changed to:', connection);
    }

    if (qr) {
      console.log('\n🔗 QR Code generated - available on dashboard');
      
      // Generate QR code as base64 image for dashboard
      try {
        currentQRCode = await QRCode.toDataURL(qr);
        connectionState.lastQR = currentQRCode;
        connectionState.lastError = null;
        console.log('✅ QR code generated for dashboard');
        
        // Also save QR to file
        const qrPath = path.join(mediaDir, 'qr.png');
        await QRCode.toFile(qrPath, qr, {
          width: 300,
          margin: 2
        });
        console.log('📱 QR code saved to:', qrPath);
        console.log('⏰ Connection is open - waiting for you to scan QR code...');
      } catch (err) {
        console.error('❌ Failed to generate QR code for dashboard:', err);
        connectionState.lastError = `QR generation failed: ${err.message}`;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || 'Unknown error';
      const errorData = lastDisconnect?.error?.data || {};
      
      if (pairingCode) {
        console.log('⚠️ Connection closed while pairing code was active!');
        console.log('   Pairing code was:', pairingCode);
        console.log('   This means WhatsApp closed connection before you could enter code.');
      }
      
      console.log('❌ Connection closed');
      console.log('   Status Code:', statusCode);
      console.log('   Error:', errorMsg);
      console.log('   Location:', errorData.location || 'unknown');
      console.log('   Reason:', errorData.reason || 'not specified');
      console.log('   Full error object:', JSON.stringify(lastDisconnect?.error, null, 2));
      
      // Store error for dashboard
      connectionState.lastError = {
        code: statusCode,
        message: errorMsg,
        location: errorData.location,
        reason: errorData.reason
      };
      
      connectionState.connected = false;
      connectionState.user = null;
      currentQRCode = null;
      
      // Handle different disconnect reasons
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('⚠️ Logged out - session invalid, clearing auth files');
        try {
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            fs.mkdirSync(authDir, { recursive: true });
          }
        } catch (err) {
          console.error('Error clearing auth:', err);
        }
        console.log('🔄 Use dashboard to reconnect with new QR/pairing code');
      } else if (statusCode === 405 || statusCode === 401) {
        console.log('⚠️ Got error', statusCode, '- clearing auth files');
        try {
          if (fs.existsSync(authDir)) {
            const files = fs.readdirSync(authDir);
            files.forEach(file => {
              const filePath = path.join(authDir, file);
              if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
              }
            });
          }
        } catch (err) {
          console.error('Error clearing auth:', err);
        }
        console.log('🔄 Use dashboard to reconnect manually');
      } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
        // Error 515/restart required - auto-reconnect
        console.log('⚠️ Restart required - auto-reconnecting in 3 seconds...');
        setTimeout(() => {
          console.log('🔄 Auto-reconnecting after restart required...');
          connectToWhatsApp(lastPhoneNumber).catch(err => {
            console.error('Error reconnecting:', err);
            connectionState.lastError = err.message;
          });
        }, 3000);
      } else {
        // Other errors - try to reconnect
        console.log('🔁 Reconnecting in 3 seconds...');
        setTimeout(() => {
          connectToWhatsApp(lastPhoneNumber).catch(err => {
            console.error('Error reconnecting:', err);
            connectionState.lastError = err.message;
          });
        }, 3000);
      }
      
    } else if (connection === 'open') {
      console.log('\n🎉 CONNECTION SUCCESSFUL!');
      currentQRCode = null;
      pairingCode = null;
      lastPhoneNumber = null; // Clear on successful connection
      connectionState.pairingCode = null;
      connectionState.connected = true;
      connectionState.user = sock.user;
      connectionState.lastError = null;
      console.log('✅ Connected to WhatsApp!');
      console.log('📱 Phone Number:', sock.user.id);
      console.log('🔐 Device is now linked and ready to receive messages');
      console.log('🎯 Message handler is active and listening for incoming messages');
      console.log('🔌 Socket readyState:', sock.ws?.readyState);
      
      // Test: Try to mark as online
      try {
        await sock.sendPresenceUpdate('available');
        console.log('✅ Presence updated to "available"');
      } catch (err) {
        console.error('⚠️ Could not update presence:', err.message);
      }
    } else if (connection === 'connecting') {
      console.log('🔌 Connecting to WhatsApp servers...');
    }
  });

  sock.ev.on('creds.update', saveCreds);
  
  console.log('🔧 Event listeners registered (messages.upsert, creds.update, connection.update)');
  
  // Log ALL socket events for debugging
  const originalOn = sock.ev.on.bind(sock.ev);
  const eventCounts = {};
  
  // Intercept all events
  ['messages.upsert', 'messages.update', 'message-receipt.update', 'presence.update', 
   'chats.upsert', 'chats.update', 'contacts.upsert', 'contacts.update'].forEach(eventName => {
    sock.ev.on(eventName, (data) => {
      eventCounts[eventName] = (eventCounts[eventName] || 0) + 1;
      if (eventName === 'messages.upsert' || eventName === 'messages.update') {
        console.log(`📡 EVENT: ${eventName} (count: ${eventCounts[eventName]})`);
      }
    });
  });
  
  // Log event stats every 30 seconds
  setInterval(() => {
    if (Object.keys(eventCounts).length > 0) {
      console.log('📊 Event stats (last 30s):', eventCounts);
    }
  }, 30000);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('🔔 messages.upsert EVENT TRIGGERED! Type:', type, 'Count:', messages.length);
    console.log('🔗 Socket connection state:', connectionState.connected ? 'CONNECTED' : 'DISCONNECTED');
    
    for (const msg of messages) {
      try {
        console.log('📨 RAW MESSAGE RECEIVED:', JSON.stringify(msg.key, null, 2));
        
        if (!msg?.message) {
          console.log('⚠️ Message has no content, skipping');
          continue;
        }

        const rawUser = msg.key.remoteJid;
        const user = normalizeUser(rawUser);
        
        console.log('👤 Remote JID:', rawUser);
        console.log('👤 Normalized User:', user);

        // Ignore status broadcasts and group chats
        if (!user || user === 'status@broadcast' || user.includes('@g.us')) {
          console.log('⏭️ Skipping (status/group):', user);
          continue;
        }

        const messageText = extractText(msg);
        console.log('📝 Extracted Text:', messageText);
        
        if (!messageText) {
          console.log('⚠️ No text extracted, skipping');
          continue;
        }

        // Handle admin outgoing messages (fromMe)
        if (msg.key.fromMe) {
          const cmd = messageText.toLowerCase();
          
          console.log('📤 ADMIN OUTGOING TO:', user);
          console.log('💬 ADMIN TEXT:', messageText);

          // Check for handover commands
          if (HANDOVER_COMMANDS.includes(cmd)) {
            handoverUsers[user] = true;
            if (messageBuffer[user]?.timer) {
              clearTimeout(messageBuffer[user].timer);
            }
            delete messageBuffer[user];
            console.log('🔥 HANDOVER AKTIF:', user);
            continue;
          }

          // Check for resume commands
          if (RESUME_COMMANDS.includes(cmd)) {
            delete handoverUsers[user];
            console.log('✅ BOT RESUMED FOR:', user);
            continue;
          }

          continue;
        }

        // Handle incoming user messages
        const from = msg.key.remoteJid;
        const messageId = msg.key.id;

        console.log('📩 FROM:', user);
        console.log('💬 MESSAGE:', messageText);

        // Check if handover is active for this user
        if (handoverUsers[user]) {
          console.log('⛔ Handover active, skip bot for:', user);
          continue;
        }

        // Buffer messages for combined processing
        // Pass the original JID from the message key for proper reply routing
        handleIncomingMessage(user, messageText, messageId, from);

      } catch (error) {
        console.error('❌ ERROR PROCESSING MESSAGE:', error.message);
        console.error('❌ STACK:', error.stack);
        logger.error({ error: error.message }, 'Error processing message');
      }
    }
  });
}

// Message buffering and processing function
async function handleIncomingMessage(user, message, messageId, originalJid) {
  try {
    user = normalizeUser(user);

    if (handoverUsers[user]) {
      console.log('⛔ Handover active, skip bot:', user);
      return;
    }

    if (!messageBuffer[user]) {
      messageBuffer[user] = {
        messages: [],
        timer: null,
        originalJid: originalJid // Store original JID for replies
      };
    }

    messageBuffer[user].messages.push(message);
    messageBuffer[user].originalJid = originalJid; // Update on each message

    if (messageBuffer[user].timer) {
      clearTimeout(messageBuffer[user].timer);
    }

    // Process buffered messages after 10 seconds of inactivity
    messageBuffer[user].timer = setTimeout(async () => {
      try {
        const payload = [...messageBuffer[user].messages];
        const replyJid = messageBuffer[user].originalJid || user; // Use original JID for reply
        delete messageBuffer[user];

        const combinedMessage = payload.join(' ');
        console.log('🧠 COMBINED MESSAGE:', combinedMessage);

        const payloadData = {
          from: user,
          message: combinedMessage,
          message_id: messageId
        };

        console.log('📤 Sending to n8n:', N8N_WEBHOOK_URL);
        logger.info({ payload: payloadData }, 'Forwarding message to n8n');

        // Send to n8n webhook
        const response = await axios.post(N8N_WEBHOOK_URL, payloadData, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });

        const data = response.data;
        console.log('📦 N8N RESPONSE:', JSON.stringify(data));

        if (!data || typeof data !== 'object') {
          console.error('⚠️ Invalid n8n response format:', data);
          return;
        }

        if (!sock || !connectionState.connected) {
          console.log('❌ Socket not connected, cannot send reply');
          return;
        }

        // Use the original JID format for reply (supports both LID and traditional format)
        console.log('📨 Sending reply to JID:', replyJid);
        
        try {
          let sent;
          
          // Check response format: support both direct fields and action-based format
          const imageUrl = data.image || data.media_url;
          const videoUrl = data.video || (data.action === 'send_video' ? data.media_url : null);
          const isImageAction = data.action === 'send_image' || data.action === 'image';
          const isVideoAction = data.action === 'send_video' || data.action === 'video';
          
          // Check if response includes an image
          if (imageUrl && (data.image || isImageAction)) {
            console.log('📸 Sending image response');
            console.log('🖼️ Image URL:', imageUrl);
            console.log('📝 Caption:', data.caption || data.message || '');
            
            sent = await sock.sendMessage(replyJid, {
              image: { url: imageUrl },
              caption: data.caption || data.message || ''
            });
            console.log('✅ IMAGE SENT! ID:', sent?.key?.id);
          }
          // Check if response includes a video
          else if (videoUrl || isVideoAction) {
            const finalVideoUrl = videoUrl || data.media_url;
            console.log('🎥 Sending video response');
            console.log('📹 Video URL:', finalVideoUrl);
            console.log('📝 Caption:', data.caption || data.message || '');
            
            sent = await sock.sendMessage(replyJid, {
              video: { url: finalVideoUrl },
              caption: data.caption || data.message || ''
            });
            console.log('✅ VIDEO SENT! ID:', sent?.key?.id);
          }
          // Default: send text message
          else {
            const reply = data.message || data.caption || "Maaf kak, terjadi error 😊";
            console.log('💬 Sending text reply:', reply);
            
            sent = await sock.sendMessage(replyJid, { text: reply });
            console.log('✅ TEXT SENT! ID:', sent?.key?.id);
          }
          
          console.log('🤖 AI REPLY DELIVERED');
        } catch (sendError) {
          console.error('❌ Failed to send message:', sendError.message);
          console.error('❌ JID used:', replyJid);
          console.error('❌ Error details:', JSON.stringify(sendError, null, 2));
          // Don't crash, just log and continue
        }

        logger.info('Message successfully forwarded and replied');

        // Handle handover flag from n8n
        if (data.handover === true) {
          handoverUsers[user] = true;
          console.log('🔥 HANDOVER AKTIF (from n8n):', user);

          // Auto-reset handover after 30 minutes
          setTimeout(() => {
            delete handoverUsers[user];
            console.log('🔄 AUTO RESET HANDOVER:', user);
          }, 1800000);
        }

      } catch (error) {
        console.error('❌ Fetch/send error:', error.message);
        console.error('❌ Error details:', error.response?.data || error);
        logger.error({ error: error.message }, 'Error in message processing');
      }
    }, 10000); // 10 seconds buffer time

  } catch (err) {
    console.error('❌ Buffer error:', err.message);
  }
}

// Express endpoints

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Get backend logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({
    success: true,
    logs: logBuffer.slice(0, limit)
  });
});

// API endpoints for dashboard
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    connected: connectionState.connected,
    user: connectionState.user,
    pairingCode: connectionState.pairingCode,
    lastError: connectionState.lastError
  });
});

app.get('/api/qr', async (req, res) => {
  try {
    if (connectionState.connected) {
      return res.json({
        success: false,
        message: 'Already connected to WhatsApp',
        qr: null
      });
    }

    if (currentQRCode) {
      return res.json({
        success: true,
        qr: currentQRCode,
        message: 'QR code available'
      });
    }

    // If no QR code is available, trigger a new connection attempt (ONLY ONCE)
    if (!sock || !sock.ws || sock.ws.readyState !== 1) {
      connectToWhatsApp().catch(console.error);
      
      // Wait up to 10 seconds for QR or error
      let attempts = 0;
      const maxAttempts = 10;
      
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
        
        // Check if QR was generated
        if (currentQRCode) {
          return res.json({
            success: true,
            qr: currentQRCode,
            message: 'QR code generated'
          });
        }
        
        // Check if there was an error
        if (connectionState.lastError) {
          return res.json({
            success: false,
            message: `Connection failed: ${connectionState.lastError.message || 'Unknown error'}`,
            error: connectionState.lastError,
            qr: null
          });
        }
      }
    }

    // Return the last generated QR if available
    if (connectionState.lastQR) {
      return res.json({
        success: true,
        qr: connectionState.lastQR,
        message: 'Previous QR code (may be expired)'
      });
    }

    // Check for error before returning timeout
    if (connectionState.lastError) {
      return res.json({
        success: false,
        message: `Connection failed: ${connectionState.lastError.message || 'Unknown error'}`,
        error: connectionState.lastError,
        qr: null
      });
    }

    res.json({
      success: false,
      message: 'No QR code available. Connection may still be in progress.',
      qr: null
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Error generating QR code');
    res.status(500).json({
      success: false,
      error: error.message,
      qr: null
    });
  }
});

app.post('/api/reconnect', async (req, res) => {
  try {
    // Close existing connection
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        // Ignore logout errors
      }
      sock.end();
      sock = null;
    }
    
    // Clear all state including errors
    currentQRCode = null;
    pairingCode = null;
    lastPhoneNumber = null;
    connectionState.lastQR = null;
    connectionState.pairingCode = null;
    connectionState.connected = false;
    connectionState.user = null;
    connectionState.lastError = null;
    lastError = null;
    
    // Clear auth files to force fresh QR
    if (fs.existsSync(authDir)) {
      try {
        const files = fs.readdirSync(authDir);
        files.forEach(file => {
          const filePath = path.join(authDir, file);
          try {
            if (fs.statSync(filePath).isFile()) {
              fs.unlinkSync(filePath);
            }
          } catch (err) {
            console.error(`Error deleting ${file}:`, err);
          }
        });
        console.log('🗑️ Cleared all auth files for fresh connection');
      } catch (err) {
        console.error('Error clearing auth directory:', err);
      }
    }
    
    // Start connection (NO AUTO-RETRY - will only try once)
    setTimeout(() => {
      console.log('🔄 Starting fresh connection (single attempt)...');
      connectToWhatsApp().catch(err => {
        console.error('Error connecting:', err);
        connectionState.lastError = err.message;
      });
    }, 2000);
    
    res.json({
      success: true,
      message: 'Reconnection initiated. QR code will be generated shortly.'
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Error reconnecting');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/pairing-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    // Validate phone number format (should include country code)
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNumber.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format. Include country code (e.g., 628123456789)'
      });
    }

    if (connectionState.connected) {
      return res.json({
        success: false,
        message: 'Already connected to WhatsApp'
      });
    }

    // Close existing connection if any
    if (sock) {
      try {
        sock.end();
      } catch (e) {
        // Ignore
      }
    }

    // Clear state
    currentQRCode = null;
    pairingCode = null;
    lastPhoneNumber = null;
    connectionState.lastQR = null;
    connectionState.pairingCode = null;
    connectionState.connected = false;
    connectionState.user = null;
    connectionState.lastError = null;

    // Clear auth files
    if (fs.existsSync(authDir)) {
      try {
        const files = fs.readdirSync(authDir);
        files.forEach(file => {
          const filePath = path.join(authDir, file);
          try {
            if (fs.statSync(filePath).isFile()) {
              fs.unlinkSync(filePath);
            }
          } catch (err) {
            console.error(`Error deleting ${file}:`, err);
          }
        });
        console.log('🗑️ Cleared auth files for fresh pairing');
      } catch (err) {
        console.error('Error clearing auth directory:', err);
      }
    }

    // Start connection with phone number
    setTimeout(() => {
      console.log('🔄 Starting pairing code connection...');
      connectToWhatsApp(cleanNumber).catch(err => {
        console.error('Error connecting:', err);
        connectionState.lastError = err.message;
      });
    }, 1000);

    // Wait for pairing code to be generated
    let attempts = 0;
    const maxAttempts = 15; // 15 seconds
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      
      if (connectionState.pairingCode) {
        return res.json({
          success: true,
          pairingCode: connectionState.pairingCode,
          message: 'Pairing code generated successfully'
        });
      }
      
      if (connectionState.lastError) {
        return res.json({
          success: false,
          error: connectionState.lastError
        });
      }
    }

    res.json({
      success: false,
      error: 'Timeout waiting for pairing code. Please try again.'
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Error generating pairing code');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    // Close socket connection
    if (sock) {
      sock.end();
    }
    
    // Delete auth files
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
    }
    
    currentQRCode = null;
    connectionState.connected = false;
    connectionState.user = null;
    qrRetries = 0;
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
    
    // Reconnect after logout
    setTimeout(() => connectToWhatsApp(), 2000);
  } catch (error) {
    logger.error({ error: error.message }, 'Error logging out');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test endpoint to verify socket is working
app.post('/api/test-message', async (req, res) => {
  try {
    if (!sock || !connectionState.connected) {
      return res.json({
        success: false,
        error: 'Not connected to WhatsApp'
      });
    }
    
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.json({
        success: false,
        error: 'Missing "to" or "message" parameter'
      });
    }
    
    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
    
    console.log('🧪 TEST: Sending message to', jid);
    const result = await sock.sendMessage(jid, { text: message });
    console.log('🧪 TEST: Message sent successfully!', result.key.id);
    
    res.json({
      success: true,
      message: 'Test message sent',
      messageId: result.key.id
    });
  } catch (error) {
    console.error('🧪 TEST: Error sending test message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Legacy endpoint for backward compatibility
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    service: 'Baileys WhatsApp Bot',
    connected: sock?.user ? true : false,
    user: sock?.user || null
  });
});

// Handover management endpoints
app.post('/reset-handover', (req, res) => {
  const { user } = req.body;

  if (!user) {
    return res.status(400).json({ error: 'User required' });
  }

  delete handoverUsers[user];
  console.log('🔄 RESET HANDOVER VIA API:', user);

  res.json({ success: true, user });
});

app.get('/handover-status', (req, res) => {
  res.json({
    success: true,
    handoverUsers: Object.keys(handoverUsers),
    count: Object.keys(handoverUsers).length
  });
});

// Redis health check
app.get('/redis/health', (req, res) => {
  res.json({
    success: true,
    connected: redisClient.isOpen,
    status: redisClient.isOpen ? 'connected' : 'disconnected'
  });
});

// Set cache endpoint
app.post('/redis/set', async (req, res) => {
  try {
    const { key, value, ttl } = req.body;
    
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'key and value are required' });
    }

    const success = await setCache(key, value, ttl || 3600);
    
    res.json({ 
      success, 
      message: success ? 'Value cached successfully' : 'Failed to cache value'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get cache endpoint
app.get('/redis/get/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const value = await getCache(key);
    
    res.json({ 
      success: value !== null,
      key,
      value
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete cache endpoint
app.delete('/redis/delete/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const success = await deleteCache(key);
    
    res.json({ 
      success,
      message: success ? 'Key deleted successfully' : 'Failed to delete key'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset session endpoint (force re-scan)
app.post('/reset-session', async (req, res) => {
  try {
    console.log('🧹 FORCE RESET SESSION');
    res.json({ success: true, message: 'Session reset initiated. Container will restart.' });

    setTimeout(() => {
      try {
        if (sock) {
          try { sock.end(); } catch (e) {}
          sock = null;
        }

        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
          console.log('🗑️ AUTH FOLDER DELETED');
        }

        console.log('💣 KILLING PROCESS...');
        process.exit(0);
      } catch (e) {
        console.error('❌ RESET SESSION ERROR:', e.message);
        process.exit(1);
      }
    }, 300);
  } catch (err) {
    console.error('❌ RESET ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-message', async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, message'
      });
    }

    if (!sock || !connectionState.connected) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp not connected'
      });
    }

    // Support both formats: plain number, @s.whatsapp.net, and @lid
    let jid = to;
    if (!to.includes('@')) {
      jid = `${to}@s.whatsapp.net`;
    }
    
    console.log('📤 API: Sending message to:', jid);
    console.log('📝 Message:', message);
    
    const result = await sock.sendMessage(jid, { text: message });
    
    console.log('✅ API: Message sent successfully! ID:', result.key.id);

    res.json({
      success: true,
      message: 'Message sent successfully',
      to: jid,
      messageId: result.key.id
    });
  } catch (error) {
    console.error('❌ API: Error sending message:', error.message);
    logger.error({ error: error.message }, 'Error sending message');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/send-image', async (req, res) => {
  try {
    const { to, image, caption } = req.body;

    if (!to || !image) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, image'
      });
    }

    if (!sock || !connectionState.connected) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp not connected'
      });
    }

    // Support both formats: plain number, @s.whatsapp.net, and @lid
    let jid = to;
    if (!to.includes('@')) {
      jid = `${to}@s.whatsapp.net`;
    }
    
    console.log('📸 API: Sending image to:', jid);
    console.log('📝 Caption:', caption || 'none');
    
    // image can be a URL or base64 string
    const messageContent = {
      image: { url: image },
      caption: caption || ''
    };

    const result = await sock.sendMessage(jid, messageContent);
    console.log('✅ API: Image sent successfully! ID:', result.key.id);

    res.json({
      success: true,
      message: 'Image sent successfully',
      to: jid,
      messageId: result.key.id
    });
  } catch (error) {
    console.error('❌ API: Error sending image:', error.message);
    logger.error({ error: error.message }, 'Error sending image');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/send-video', async (req, res) => {
  try {
    const { to, video, caption } = req.body;

    if (!to || !video) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, video'
      });
    }

    if (!sock || !connectionState.connected) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp not connected'
      });
    }

    // Support both formats: plain number, @s.whatsapp.net, and @lid
    let jid = to;
    if (!to.includes('@')) {
      jid = `${to}@s.whatsapp.net`;
    }
    
    console.log('🎥 API: Sending video to:', jid);
    console.log('📝 Caption:', caption || 'none');
    
    // video can be a URL or base64 string
    const messageContent = {
      video: { url: video },
      caption: caption || ''
    };

    const result = await sock.sendMessage(jid, messageContent);
    console.log('✅ API: Video sent successfully! ID:', result.key.id);

    res.json({
      success: true,
      message: 'Video sent successfully',
      to: jid,
      messageId: result.key.id
    });
  } catch (error) {
    console.error('❌ API: Error sending video:', error.message);
    logger.error({ error: error.message }, 'Error sending video');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error({ error: err.message }, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start Express server
app.listen(PORT, () => {
  console.log(`🚀 Baileys WhatsApp Bot running on port ${PORT}`);
  console.log(`📡 N8N Webhook URL: ${N8N_WEBHOOK_URL}`);
  console.log(`🌐 Dashboard available at http://localhost:${PORT}`);
  console.log('⏳ Waiting for connection request from dashboard...');
  // Don't auto-connect - wait for dashboard request
});
