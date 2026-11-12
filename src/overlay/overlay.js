// DOM References 
const $ = (sel) => document.querySelector(sel);

const statusDot = $('#statusDot');
const statusText = $('#statusText');
const questionBox = $('#questionBox');
const questionPH = $('#questionPlaceholder');
const questionTxt = $('#questionText');
const answerBox = $('#answerBox');
const answerPH = $('#answerPlaceholder');
const answerTxt = $('#answerText');
const loader = $('#loader');
const btnListen = $('#btnListen');
const listenLabel = $('#listenLabel');
const btnType = $('#btnType');
const manualInput = $('#manualInput');
const manualQ = $('#manualQ');
const btnSend = $('#btnSend');
const btnCopy = $('#btnCopy');
const btnSetup = $('#btnSetup');
const btnClose = $('#btnClose');
const audioMeter = $('#audioMeter');
const meterSys = $('#meterSys');
const meterMic = $('#meterMic');

// State 
let isListening = false;
let isContinuousMode = false;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioContext = null;
let silenceTimeout = null;
let idleRolloverTimeout = null;

// Microphone stream used ONLY as a last-resort fallback when the
// system audio capture fails. NEVER mixed into the normal recording
// (so the user's own voice is never transcribed as a question).
let micStream = null;

// Track whether answer is currently streaming
let isStreamingAnswer = false;
let currentCycleProcessed = false;


// Status Helpers 
function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

// UI Visual Handlers 
function showQuestion(text) {
  questionPH.style.display ='none';
  questionTxt.style.display ='block';
  questionTxt.textContent = text;
}

function showAnswer(text) {
  loader.style.display ='none';
  answerPH.style.display ='none';
  answerTxt.style.display ='block';
  if (text && !isStreamingAnswer) {
    answerTxt.textContent = text;
  }
  isStreamingAnswer = false;
}

function showLoader() {
  answerPH.style.display ='none';
  answerTxt.style.display ='none';
  answerTxt.textContent ='';
  loader.style.display ='flex';
  isStreamingAnswer = false;
}

function showError(msg) {
  loader.style.display ='none';
  answerPH.style.display ='none';
  answerTxt.style.display ='block';
  answerTxt.textContent = 'Error: ' + msg;
  setStatus('error','Error occurred');
  isStreamingAnswer = false;
}

// Helpers 
// Noise guard: reject Whisper hallucinations from fan/room background noise
// (short fragments, foreign-language gibberish, filler words)
function isLikelyQuestion(text) {
  const t = (text || '').trim();
  if (t.length < 8) return false;                        // too short (at least 8 chars, e.g. "Why Java?")
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;                    // at least 2 words (e.g. "Explain Redux")
  // Reject bracketed or parenthesized sound effects from Whisper (e.g. [ding], (bell), [music])
  if (/^(\[|\().*(\]|\))$/i.test(t)) return false;
  const foreign = (t.match(/[^a-zA-Z0-9 .,?!'"-:;()&/$%@#+\n]/g) || []).length;
  if (foreign / t.length > 0.04) return false;           // foreign-language hallucination
  const hallucination = /^(thank(s| you)?|thanks (for )?watching|okay+|ok|yeah|yes|no|hello+|hi+|bye+|tchau|obrigado|gracias|merci|arigato|danke|sorry|wow|umm*|hmm*|bye bye|see you|goodbye|ding|chime|beep|bell)\b/i;
  if (hallucination.test(t)) return false;               // noise/filler word picked from background
  return true;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary ='';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ─── WAV Encoding Helpers (16kHz 16-bit Mono PCM for zero-error transcription) ───
function writeWavString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function encodeWAV(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeWavString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeWavString(view, 8, 'WAVE');
  writeWavString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // 16 bits per sample
  writeWavString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

function downsampleBuffer(buffer, sampleRate, outSampleRate = 16000) {
  if (outSampleRate === sampleRate) return buffer;
  const ratio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0, count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

// Microphone Init Helper 
async function initMic() {
  try {
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Microphone initialized');
    }
  } catch (err) {
    console.warn('Microphone access not granted or failed:', err);
  }
}

// Audio Capture (SYSTEM AUDIO ONLY - interviewer's voice) 
async function startListening(isAutoRestart = false) {
  if (isListening) return;
  currentCycleProcessed = false;
  if (!isAutoRestart) {
    isContinuousMode = true;
  }

  let analyser = null;
  let dataArray = null;
  let hasSpeechStarted = false;
  let speechStartMs = null;
  let usingMicFallback = false;

  try {
    // 1. Capture SYSTEM audio ONLY the interviewer's voice coming out
    // of the laptop. The user's microphone is NEVER mixed into the
    // recording, so their own voice can never become a "question".
    let sysTracks = [];
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      displayStream.getVideoTracks().forEach((t) => t.stop());
      sysTracks = displayStream.getAudioTracks();
      if (sysTracks.length > 0) console.log('System audio loopback captured');
    } catch (sysErr) {
      console.warn('System audio capture failed:', sysErr);
    }

    if (sysTracks.length > 0) {
      audioStream = new MediaStream(sysTracks);
      setStatus('listening','Listening for interviewer voice (system audio)...');
    } else {
      // Last-resort fallback: system capture failed/crashed microphone.
      try {
        if (!micStream || !micStream.active) {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        if (!micStream || micStream.getAudioTracks().length === 0) throw new Error('no mic track');
        audioStream = new MediaStream(micStream.getAudioTracks());
        usingMicFallback = true;
        console.warn('System audio unavailable mic fallback (your own voice may be captured)');
        setStatus('listening','System audio unavailable - microphone mode');
      } catch (micErr) {
        setStatus('error','System audio capture failed - restart the app and try again');
        isContinuousMode = false;
        stopListeningUI();
        return;
      }
    }

    // 2. Analyser for silence detection (optional broken audio devices
    // must never kill the capture flow)
    const SILENCE_DURATION = 420; // stop 420ms after speech ends (fast submit)
    const MAX_CHUNK_DURATION = 15000; // hard cap per recording cycle
    const IDLE_ROLLOVER_MS = 8000; // refresh empty buffer every 8s if no speech

    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state ==='suspended') {
        await audioContext.resume().catch(() => {});
      }
      const source = audioContext.createMediaStreamSource(audioStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
    } catch (ctxErr) {
      console.warn('AudioContext unavailable fixed-length recording mode:', ctxErr);
      audioContext = null;
      analyser = null;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ?'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ?'audio/webm'
        :'';

    const recorderOptions = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(audioStream, recorderOptions);
    audioChunks = [];
    const recordStartMs = Date.now();

    mediaRecorder.ondataavailable = (e) => {
      // Keep all chunks to guarantee container headers (EBML/Opus) are never corrupted
      if (e.data && e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    idleRolloverTimeout = setTimeout(() => {
      if (isListening && !hasSpeechStarted) {
        stopListening(false);
      }
    }, IDLE_ROLLOVER_MS);

    mediaRecorder.onstop = async () => {
      clearTimeout(maxChunkTimeout);
      maxChunkTimeout = null;
      clearTimeout(idleRolloverTimeout);
      idleRolloverTimeout = null;
      cleanupAudio();

      // If no speech was detected in this cycle, silently loop back without transcribing
      if (!hasSpeechStarted || audioChunks.length === 0) {
        setStatus('ready','Listening for interviewer voice...');
        if (isContinuousMode) {
          listenLabel.textContent ='Listening...';
          setTimeout(() => startListening(true), 150);
        } else {
          stopListeningUI();
        }
        return;
      }

      const actualMime = mimeType ? mimeType.split(';')[0] :'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: actualMime });

      // Discard sound bursts shorter than 900ms (system pop-up sounds, dings, mouse clicks, notifications)
      // Real interviewer questions take at least 900-1200ms of spoken audio
      const speechDurationMs = speechStartMs ? (Date.now() - speechStartMs) : 0;
      if (speechDurationMs < 900) {
        console.log(`Audio burst too short for an interview question (${speechDurationMs}ms) - ignoring pop-up sound`);
        if (isContinuousMode) {
          listenLabel.textContent ='Listening...';
          setTimeout(() => startListening(true), 150);
        } else {
          stopListeningUI();
        }
        return;
      }

      if (audioBlob.size >= 200) {
        const arrayBuffer = await audioBlob.arrayBuffer();
        let base64Audio;
        let submitMime = 'audio/wav';

        try {
          // Decode browser audio into raw PCM and export as standard 16kHz mono WAV for 100% reliable transcription
          const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
          const decoded = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
          const pcm = decoded.getChannelData(0);
          const downsampled = downsampleBuffer(pcm, decoded.sampleRate, 16000);
          const wavBuffer = encodeWAV(downsampled, 16000);
          base64Audio = arrayBufferToBase64(wavBuffer);
          tempCtx.close().catch(() => {});
        } catch (convErr) {
          console.warn('WAV conversion fallback to webm:', convErr);
          base64Audio = arrayBufferToBase64(arrayBuffer);
          submitMime = actualMime;
        }

        setStatus('thinking','Transcribing question...');
        if (isContinuousMode) {
          listenLabel.textContent ='Transcribing...';
        } else {
          stopListeningUI();
        }
        // Do NOT call showLoader() here! Keep the existing answer visible so screen never goes blank on noise

        try {
          const result = await window.api.transcribeAudio(base64Audio, submitMime);
          const transcribed = (result.success && result.text) ? result.text.trim() : '';
          if (transcribed && isLikelyQuestion(transcribed)) {
            currentCycleProcessed = true;
            processQuestion(transcribed);
          } else if (result.success) {
            // Not a question (or brief noise) - keep previous answer intact and keep listening
            setStatus('listening','Listening for interviewer voice (system audio)...');
            loader.style.display ='none';
            if (isContinuousMode) {
              listenLabel.textContent ='Listening...';
              startListening(true);
            } else {
              stopListeningUI();
            }
          } else {
            showError(result.error ||'Transcription failed');
            if (isContinuousMode) {
              listenLabel.textContent ='Resuming...';
              setTimeout(() => startListening(true), 500);
            }
          }
        } catch (e) {
          showError('Transcription failed: ' + e.message);
          if (isContinuousMode) {
            listenLabel.textContent ='Resuming...';
            setTimeout(() => startListening(true), 1500);
          }
        }
      } else {
        if (isContinuousMode) {
          listenLabel.textContent ='Listening...';
          setTimeout(() => startListening(true), 200);
        } else {
          stopListeningUI();
        }
      }
    };

    mediaRecorder.start(250);

    isListening = true;
    btnListen.classList.add('active');
    listenLabel.textContent ='Listening...';
    setStatus('listening', usingMicFallback
      ?'System audio unavailable - microphone mode'
      :'Listening for interviewer voice (system audio)...');
    audioMeter.style.display ='flex';
    meterMic.style.width ='0%';

    let maxChunkTimeout = null;

    if (analyser) {
      let meterTick = 0;
      let consecutiveVoiceFrames = 0;
      const SPEECH_THRESHOLD = usingMicFallback ? 6.0 : 3.6;

      maxChunkTimeout = setTimeout(() => {
        if (isListening && hasSpeechStarted) stopListening(false);
      }, MAX_CHUNK_DURATION);

      function checkSilence() {
        if (!isListening) return;
        analyser.getByteFrequencyData(dataArray);

        // Vocal Formant Analysis: Human voice formants (~300Hz - 3200Hz, bins 3 to 34)
        // vs. high-frequency notification dings/pings/clicks (>3500Hz, bins 38 to 128)
        let voiceSum = 0;
        for (let i = 3; i <= 34; i++) voiceSum += dataArray[i];
        const voiceAvg = voiceSum / 32;

        let highSum = 0;
        for (let i = 38; i <= 128; i++) highSum += dataArray[i];
        const highAvg = highSum / 91;

        const totalAvg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (++meterTick % 4 === 0) {
          meterSys.style.width = Math.min(100, totalAvg * 3.5) + '%';
          if (usingMicFallback) meterMic.style.width = Math.min(100, totalAvg * 3.5) + '%';
        }

        // Voice detection criteria:
        // 1. Adequate voice band energy (voiceAvg >= SPEECH_THRESHOLD)
        // 2. Reject high-pitched bell chimes/pings: voice band must dominate or exceed high frequencies
        const isVoiceFrequency = voiceAvg >= SPEECH_THRESHOLD && (voiceAvg >= highAvg * 1.1 || highAvg < 3.5);

        if (isVoiceFrequency) {
          consecutiveVoiceFrames++;
          // Require at least 7 consecutive frames (~115ms) of sustained human vocal energy
          // to completely ignore single-spike pop-up sounds, clicks, and alert dings
          if (consecutiveVoiceFrames >= 7) {
            if (!hasSpeechStarted) {
              hasSpeechStarted = true;
              speechStartMs = Date.now();
              clearTimeout(idleRolloverTimeout);
              idleRolloverTimeout = null;
              setStatus('listening', 'Question detected - listening...');
              listenLabel.textContent = 'Recording...';
            }
            clearTimeout(silenceTimeout);
            silenceTimeout = null;
          }
        } else {
          consecutiveVoiceFrames = Math.max(0, consecutiveVoiceFrames - 2);
          if (hasSpeechStarted && !silenceTimeout) {
            silenceTimeout = setTimeout(() => {
              if (isListening) stopListening(false);
            }, SILENCE_DURATION);
          }
        }

        requestAnimationFrame(checkSilence);
      }
      checkSilence();
    } else {
      // No analyser fixed 12s recording chunks
      console.warn('Fixed-length recording mode (12s chunks)');
      maxChunkTimeout = setTimeout(() => {
        if (isListening) stopListening(false);
      }, 12000);
    }

  } catch (e) {
    console.error('Audio capture setup error:', e);
    setStatus('error','Audio capture error: ' + e.message);
    isContinuousMode = false;
    stopListeningUI();
  }
}

function stopListening(isManual = false) {
  isListening = false;
  if (isManual) {
    isContinuousMode = false;
  }
  clearTimeout(silenceTimeout);
  silenceTimeout = null;
  clearTimeout(idleRolloverTimeout);
  idleRolloverTimeout = null;

  if (mediaRecorder && mediaRecorder.state !=='inactive') {
    mediaRecorder.stop();
  } else {
    cleanupAudio();
    stopListeningUI();
  }
}

function cleanupAudio() {
  if (audioContext && audioContext.state !=='closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function stopListeningUI() {
  isListening = false;
  btnListen.classList.remove('active');
  listenLabel.textContent ='Start Listening';
  audioMeter.style.display ='none';
}

// Process Question Generate Answer 
async function processQuestion(question) {
  if (!question) return;

  console.log(`Processing question: "${question}"`);
  showQuestion(question);
  showLoader();
  setStatus('thinking','Generating answer...');
  if (isContinuousMode) {
    listenLabel.textContent ='Thinking...';
  }

  try {
    const result = await window.api.generateAnswer(question);
    console.log('Generate answer result:', { success: result.success, hasAnswer: !!result.answer });
    
    if (result.success) {
      if (isStreamingAnswer && answerTxt.textContent.length > 0) {
        loader.style.display ='none';
        answerPH.style.display ='none';
        answerTxt.style.display ='block';
        isStreamingAnswer = false;
      } else {
        showAnswer(result.answer);
      }
      setStatus('ready','Answer ready');
      if (isContinuousMode) {
        listenLabel.textContent ='Resuming...';
        setTimeout(() => startListening(true), 500);
      }
    } else {
      console.error('Answer generation failed:', result.error);
      showError(result.error);
      if (isContinuousMode) {
        listenLabel.textContent ='Resuming...';
        setTimeout(() => startListening(true), 1000);
      }
    }
  } catch (e) {
    console.error('Answer generation exception:', e);
    showError('Failed to generate answer: ' + e.message);
    if (isContinuousMode) {
      listenLabel.textContent ='Resuming...';
      setTimeout(() => startListening(true), 2000);
    }
  }
}

// Event Listeners 

btnListen.addEventListener('click', () => {
  if (isContinuousMode || isListening) {
    stopListening(true);
    setStatus('ready','Ready');
  } else {
    startListening();
  }
});

btnType.addEventListener('click', () => {
  const vis = manualInput.style.display ==='none';
  manualInput.style.display = vis ?'flex' :'none';
  if (vis) manualQ.focus();
});

btnSend.addEventListener('click', () => {
  const q = manualQ.value.trim();
  if (q) {
    manualQ.value ='';
    processQuestion(q);
  }
});
manualQ.addEventListener('keydown', (e) => {
  if (e.key ==='Enter') btnSend.click();
});

btnCopy.addEventListener('click', () => {
  const text = answerTxt.textContent;
  if (text && answerTxt.style.display !=='none') {
    navigator.clipboard.writeText(text);
    btnCopy.textContent ='Copied';
    setTimeout(() => btnCopy.textContent ='Copy', 1500);
  }
});

btnSetup.addEventListener('click', () => window.api.showSetup());
btnClose.addEventListener('click', () => window.api.hideOverlay());

document.addEventListener('keydown', (e) => {
  if (e.key ==='Escape') window.api.hideOverlay();
});

// Init 
window.api.onAnswerChunk((chunk) => {
  if (loader.style.display !=='none') {
    loader.style.display ='none';
    answerPH.style.display ='none';
    answerTxt.style.display ='block';
    answerTxt.textContent ='';
    isStreamingAnswer = true;
  }
  answerTxt.textContent += chunk;
});

setStatus('ready','Ready');

window.addEventListener('DOMContentLoaded', () => {
  initMic().then(() => {
    setTimeout(() => {
      console.log('Auto-starting mock interview listener loop...');
      startListening();
    }, 1000);
  });
});
