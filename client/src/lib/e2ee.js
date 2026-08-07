const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 250_000;

/**
 * Chromium-family browsers only (as of writing). Firefox/Safari lack
 * `createEncodedStreams`, so we detect and let callers fall back to
 * DTLS-SRTP-only with a visible warning rather than pretending E2EE ran.
 */
export function isInsertableStreamsSupported() {
  return (
    typeof RTCRtpSender !== 'undefined' &&
    typeof RTCRtpSender.prototype.createEncodedStreams === 'function' &&
    typeof RTCRtpReceiver !== 'undefined' &&
    typeof RTCRtpReceiver.prototype.createEncodedStreams === 'function'
  );
}

/**
 * The room key never touches the signaling server: the passphrase lives
 * only in the URL fragment (never sent in HTTP requests or emitted to
 * Socket.IO), and roomId is used purely as a PBKDF2 salt.
 */
export async function deriveRoomKey(passphrase, roomId) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(roomId),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Leave a small unencrypted header so codecs can still read frame metadata
// (keyframe flag, temporal layering) — same convention as the WebRTC
// insertable-streams reference samples. It never exposes pixel/audio content.
function unencryptedHeaderLength(frame) {
  if (frame.type === undefined) return 1; // audio frames have no `type`
  return frame.type === 'key' ? 10 : 3;
}

function makeEncryptTransform(getKey) {
  return new TransformStream({
    async transform(frame, controller) {
      const key = getKey();
      if (!key) {
        controller.enqueue(frame);
        return;
      }
      const header = unencryptedHeaderLength(frame);
      const data = new Uint8Array(frame.data);
      if (data.byteLength <= header) {
        controller.enqueue(frame);
        return;
      }
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const plaintext = data.subarray(header);
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
      );
      const output = new Uint8Array(header + IV_LENGTH + ciphertext.byteLength);
      output.set(data.subarray(0, header), 0);
      output.set(iv, header);
      output.set(ciphertext, header + IV_LENGTH);
      frame.data = output.buffer;
      controller.enqueue(frame);
    },
  });
}

function makeDecryptTransform(getKey) {
  return new TransformStream({
    async transform(frame, controller) {
      const key = getKey();
      if (!key) {
        controller.enqueue(frame);
        return;
      }
      const header = unencryptedHeaderLength(frame);
      const data = new Uint8Array(frame.data);
      if (data.byteLength < header + IV_LENGTH) {
        return; // malformed/not-yet-encrypted frame — drop, don't hand garbage to the decoder
      }
      const iv = data.subarray(header, header + IV_LENGTH);
      const ciphertext = data.subarray(header + IV_LENGTH);
      try {
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext),
        );
        const output = new Uint8Array(header + plaintext.byteLength);
        output.set(data.subarray(0, header), 0);
        output.set(plaintext, header);
        frame.data = output.buffer;
        controller.enqueue(frame);
      } catch {
        // Wrong/missing key (e.g. mistyped passphrase) — drop rather than
        // surface decrypted garbage to the decoder.
      }
    },
  });
}

/**
 * @param {RTCRtpSender} sender
 * @param {() => CryptoKey | null} getKey lazily read so callers can attach
 *   transforms before the room key finishes deriving.
 */
export function attachEncryption(sender, getKey) {
  if (!isInsertableStreamsSupported()) return;
  const { readable, writable } = sender.createEncodedStreams();
  readable.pipeThrough(makeEncryptTransform(getKey)).pipeTo(writable);
}

/**
 * @param {RTCRtpReceiver} receiver
 * @param {() => CryptoKey | null} getKey
 */
export function attachDecryption(receiver, getKey) {
  if (!isInsertableStreamsSupported()) return;
  const { readable, writable } = receiver.createEncodedStreams();
  readable.pipeThrough(makeDecryptTransform(getKey)).pipeTo(writable);
}
