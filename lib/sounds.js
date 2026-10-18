/**
 * System sound notifications via macOS afplay
 * Only works on macOS — uses built-in system sounds
 * 
 * Volume: float multiplier where 1.0 = normal system volume
 *   0.5 = half volume, 2.0 = double, 5.0 = 5x louder
 */

const { exec } = require('child_process');
const path = require('path');

const SOUNDS_DIR = '/System/Library/Sounds';

// Configurable sound settings
const CONFIG = {
  meetingPrepReady: {
    sound: 'Glass.aiff',
    volume: 3.0,        // 3x normal — noticeable but not alarming
    repeat: 1,
  },
  meetingImminent: {
    sound: 'Funk.aiff',
    volume: 5.0,        // 5x normal — attention-grabbing
    repeat: 3,          // plays three times
    gapMs: 0,           // no gap — sequential, back to back
  },
  taskComplete: {
    sound: 'Pop.aiff',
    volume: 2.0,
    repeat: 1,
  },
  error: {
    sound: 'Basso.aiff',
    volume: 3.0,
    repeat: 1,
  },
  notification: {
    sound: 'Ping.aiff',
    volume: 2.0,
    repeat: 1,
  },
};

/**
 * Play a system sound
 * @param {string} soundFile - Filename like 'Glass.aiff'
 * @param {number} volume - Float multiplier (1.0 = normal, 5.0 = 5x louder)
 */
function playSound(soundFile, volume = 1.0) {
  const soundPath = path.join(SOUNDS_DIR, soundFile);

  return new Promise((resolve, reject) => {
    exec(`afplay -v ${volume} "${soundPath}"`, (error) => {
      if (error) {
        console.error(`[sounds] Failed to play ${soundFile}:`, error.message);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Play a configured sound event (with repeat support)
 * @param {string} eventName - Key from CONFIG
 */
async function playSoundEvent(eventName) {
  const cfg = CONFIG[eventName];
  if (!cfg) {
    console.error(`[sounds] Unknown event: ${eventName}`);
    return;
  }

  for (let i = 0; i < cfg.repeat; i++) {
    await playSound(cfg.sound, cfg.volume);
    if (i < cfg.repeat - 1 && cfg.gapMs) {
      await new Promise(r => setTimeout(r, cfg.gapMs));
    }
  }
}

/**
 * Play the meeting prep ready sound
 */
function notifyMeetingPrepReady() {
  console.log('[sounds] 🔔 Meeting prep document ready');
  return playSoundEvent('meetingPrepReady');
}

/**
 * Play the meeting imminent sound (1 min warning)
 * Plays twice for urgency
 */
async function notifyMeetingImminent(meetingTitle) {
  console.log(`[sounds] 🚨 1 minute until: ${meetingTitle}`);
  return playSoundEvent('meetingImminent');
}

module.exports = {
  playSound,
  playSoundEvent,
  notifyMeetingPrepReady,
  notifyMeetingImminent,
  CONFIG,
};
