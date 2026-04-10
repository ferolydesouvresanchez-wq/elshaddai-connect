const NodeMediaServer = require('node-media-server');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const { decrypt } = require('./encryption');

/**
 * RTMP Relay Server
 *
 * Architecture:
 * Browser → canvas.captureStream() → MediaRecorder → WebSocket chunks → RTMP ingest
 * RTMP ingest → FFmpeg → Multi-platform relay (YouTube, Facebook, etc.)
 *
 * The relay accepts RTMP input on port 1935 and re-streams to all enabled platforms.
 * Stream keys are decrypted from the database at relay time — never exposed to the client.
 */

const RTMP_PORT = parseInt(process.env.RTMP_PORT) || 1935;
const HTTP_FLV_PORT = parseInt(process.env.HTTP_FLV_PORT) || 8000;

// Active FFmpeg relay processes per session
const activeRelays = new Map();

/**
 * Initialize the RTMP relay server (node-media-server)
 * Accepts incoming RTMP streams and triggers multi-platform relay via FFmpeg
 */
function initRelayServer(db) {
  const config = {
    logType: 1,
    rtmp: {
      port: RTMP_PORT,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
    http: {
      port: HTTP_FLV_PORT,
      allow_origin: '*',
      mediaroot: './media',
    },
    auth: {
      play: false,
      publish: false, // We handle auth at the API level
    },
  };

  const nms = new NodeMediaServer(config);

  // When a stream starts publishing, relay to all enabled platforms
  nms.on('postPublish', (id, streamPath, args) => {
    console.log(`[Relay] Stream published: ${streamPath} (session: ${id})`);

    // streamPath format: /live/{sessionId}
    const parts = streamPath.split('/');
    const sessionId = parts[parts.length - 1];

    if (!sessionId) {
      console.warn('[Relay] No session ID in stream path');
      return;
    }

    // Look up session host and their enabled platforms
    const session = db.prepare('SELECT * FROM stream_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      console.warn(`[Relay] Session ${sessionId} not found`);
      return;
    }

    const platforms = db.prepare(
      'SELECT * FROM stream_platforms WHERE userId = ? AND enabled = 1'
    ).all(session.hostId);

    if (platforms.length === 0) {
      console.log('[Relay] No enabled platforms to relay to');
      return;
    }

    // Start FFmpeg relay processes for each platform
    const relayProcesses = [];
    for (const platform of platforms) {
      try {
        const streamKey = decrypt(platform.encryptedKey);
        if (!streamKey) {
          console.warn(`[Relay] Could not decrypt key for ${platform.platform}`);
          continue;
        }

        const rtmpDest = `${platform.rtmpUrl}${streamKey}`;
        console.log(`[Relay] Starting relay to ${platform.platform} (${platform.label})`);

        const ffmpeg = spawn(ffmpegPath, [
          '-i', `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`,
          '-c', 'copy',        // No re-encoding, just relay
          '-f', 'flv',
          '-flvflags', 'no_duration_filesize',
          rtmpDest,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        ffmpeg.stdout.on('data', (data) => {
          // FFmpeg logs go to stderr, stdout is minimal
        });

        ffmpeg.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg.includes('error') || msg.includes('Error')) {
            console.error(`[Relay:${platform.platform}] ${msg}`);
          }
        });

        ffmpeg.on('close', (code) => {
          console.log(`[Relay:${platform.platform}] FFmpeg exited with code ${code}`);
        });

        ffmpeg.on('error', (err) => {
          console.error(`[Relay:${platform.platform}] FFmpeg spawn error:`, err.message);
        });

        relayProcesses.push({ platform: platform.platform, process: ffmpeg, platformId: platform.id });
      } catch (err) {
        console.error(`[Relay] Error starting relay for ${platform.platform}:`, err.message);
      }
    }

    activeRelays.set(sessionId, relayProcesses);
    console.log(`[Relay] Relaying to ${relayProcesses.length} platform(s)`);
  });

  // When a stream stops, kill all relay processes
  nms.on('donePublish', (id, streamPath) => {
    console.log(`[Relay] Stream ended: ${streamPath}`);
    const parts = streamPath.split('/');
    const sessionId = parts[parts.length - 1];
    stopRelay(sessionId);
  });

  // Start the RTMP server
  try {
    nms.run();
    console.log(`[Relay] RTMP server listening on port ${RTMP_PORT}`);
    console.log(`[Relay] HTTP-FLV server listening on port ${HTTP_FLV_PORT}`);
  } catch (err) {
    console.error(`[Relay] Failed to start RTMP server: ${err.message}`);
    console.error('[Relay] RTMP relay will not be available. Ensure ports are not in use.');
  }

  return nms;
}

/**
 * Stop all relay processes for a session
 */
function stopRelay(sessionId) {
  const relays = activeRelays.get(sessionId);
  if (relays) {
    for (const relay of relays) {
      try {
        relay.process.kill('SIGTERM');
        console.log(`[Relay] Stopped relay to ${relay.platform}`);
      } catch (e) {
        // Process may already be dead
      }
    }
    activeRelays.delete(sessionId);
  }
}

/**
 * Get status of active relays
 */
function getRelayStatus() {
  const status = {};
  for (const [sessionId, relays] of activeRelays) {
    status[sessionId] = relays.map(r => ({
      platform: r.platform,
      platformId: r.platformId,
      active: !r.process.killed,
      pid: r.process.pid,
    }));
  }
  return status;
}

module.exports = {
  initRelayServer,
  stopRelay,
  getRelayStatus,
  RTMP_PORT,
  HTTP_FLV_PORT,
};
