// â”€â”€â”€ DOM References â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const $ = (sel) => document.querySelector(sel);

const statusDot   = $('#statusDot');
const statusText  = $('#statusText');
const questionBox = $('#questionBox');
const questionPH  = $('#questionPlaceholder');
const questionTxt = $('#questionText');
const answerBox   = $('#answerBox');
const answerPH    = $('#answerPlaceholder');
const answerTxt   = $('#answerText');
const loader      = $('#loader');
const btnListen   = $('#btnListen');
const listenLabel = $('#listenLabel');
const btnType     = $('#btnType');
const manualInput = $('#manualInput');
const manualQ     = $('#manualQ');
const btnSend     = $('#btnSend');
const btnCopy     = $('#btnCopy');
const btnSetup    = $('#btnSetup');
const btnClose    = $('#btnClose');
const audioMeter  = $('#audioMeter');
const meterSys    = $('#meterSys');
const meterMic    = $('#meterMic');

// â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let isListening = false;
let isContinuousMode = false;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioContext = null;
let silenceTimeout = null;

// Microphone stream â€” used ONLY as a last-resort fallback when the
// system audio capture fails. NEVER mixed into the normal recording
// (so the user's own voice is never transcribed as a question).
let micStream = null;

// Track whether answer is currently streaming
let isStreamingAnswer = false;
let currentCycleProcessed = false;


// â”€â”€â”€ Status Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

// â”€â”€â”€ UI Visual Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showQuestion(text) {
  questionPH.style.display = 'none';
  questionTxt.style.display = 'block';
  questionTxt.textContent = text;
}

function showAnswer(text) {
  loader.style.display = 'none';
  answerPH.style.display = 'none';
  answerTxt.style.display = 'block';
  if (text && !isStreamingAnswer) {
    answerTxt.textContent = text;
  }
  isStreamingAnswer = false;
}

function showLoader() {
  answerPH.style.display = 'none';
  answerTxt.style.display = 'none';
  answerTxt.textContent = '';
  loader.style.display = 'flex';
  isStreamingAnswer = false;
}

function showError(msg) {
  loader.style.display = 'none';
  answerPH.style.display = 'none';
  answerTxt.style.display = 'block';
  answerTxt.textContent = 'âš ï¸ ' + msg;
  setStatus('error', 'Error occurred');
  isStreamingAnswer = false;
}

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// â”€â”€â”€ Microphone Init Helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function initMic() {
  try {
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('âœ“ Microphone initialized');
    }
  } catch (err) {
    console.warn('Microphone access not granted or failed:', err);
  }
}

// ─── Audio Capture (SYSTEM AUDIO ONLY — interviewer's voice) ────
async function startListening(isAutoRestart = false) {
  if (isListening) return;
  currentCycleProcessed = false;
  if (!isAutoRestart) {
    isContinuousMode = true;
  }

  let analyser = null;
  let dataArray = null;
  let hasSpeechStarted = false;
  let usingMicFallback = false;

  try {
    // 1. Capture SYSTEM audio ONLY â€” the interviewer's voice coming out
    //    of the laptop. The user's microphone is NEVER mixed into the
    //    recording, so their own voice can never become a "question".
    let sysTracks = [];
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      displayStream.getVideoTracks().forEach((t) => t.stop());
      sysTracks = displayStream.getAudioTracks();
      if (sysTracks.length > 0) console.log('âœ“ System audio loopback captured');
    } catch (sysErr) {
      console.warn('System audio capture failed:', sysErr);
    }

    if (sysTracks.length > 0) {
      audioStream = new MediaStream(sysTracks);
      setStatus('listening', 'Listening for interviewer voice (system audio)...');
    } else {
      // Last-resort fallback: system capture failed/crashed â†’ microphone.
      try {
        if (!micStream || !micStream.active) {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        if (!micStream || micStream.getAudioTracks().length === 0) throw new Error('no mic track');
        audioStream = new MediaStream(micStream.getAudioTracks());
        usingMicFallback = true;
        console.warn('âš  System audio unavailable â€” mic fallback (your own voice may be captured)');
        setStatus('listening', 'System audio unavailable â€” microphone mode');
      } catch (micErr) {
        setStatus('error', 'System audio capture failed â€” restart the app and try again');
        isContinuousMode = false;
        stopListeningUI();
        return;
      }
    }

    // 2. Analyser for silence detection (optional â€” broken audio devices
    //    must never kill the capture flow)
    const SILENCE_DURATION = 1200;      // stop 1.2s after speech ends (fast submit)
    const MAX_CHUNK_DURATION = 20000;   // hard cap per recording cycle
    const CALIBRATION_MS = 1200;        // measure ambient noise for 1.2s at start

    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') {
        await audioContext.resume().catch(() => {});
      }
      const source = audioContext.createMediaStreamSource(audioStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
    } catch (ctxErr) {
      console.warn('AudioContext unavailable â€” fixed-length recording mode:', ctxErr);
      audioContext = null;
      analyser = null;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';

    const recorderOptions = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(audioStream, recorderOptions);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      clearTimeout(maxChunkTimeout);
      maxChunkTimeout = null;
      cleanupAudio();

      if (audioChunks.length === 0) {
        setStatus('ready', 'Listening...');
        if (isContinuousMode) {
          listenLabel.textContent = 'Listening...';
          setTimeout(() => startListening(true), 300);
        } else {
          stopListeningUI();
        }
        return;
      }

      const actualMime = mimeType ? mimeType.split(';')[0] : 'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: actualMime });

      if (audioBlob.size >= 200) {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const base64Audio = arrayBufferToBase64(arrayBuffer);

        setStatus('thinking', 'âš¡ Transcribing question...');
        if (isContinuousMode) {
          listenLabel.textContent = 'Transcribing...';
        } else {
          stopListeningUI();
        }
        showLoader();

        try {
          const result = await window.api.transcribeAudio(base64Audio, actualMime);
          if (result.success && result.text && result.text.trim().length > 0) {
            currentCycleProcessed = true;
            processQuestion(result.text.trim());
          } else if (result.success) {
            // No speech in this chunk â€” keep listening
            setStatus('listening', 'Listening for interview questions...');
            loader.style.display = 'none';
            if (isContinuousMode) {
              listenLabel.textContent = 'Listening...';
              startListening(true);
            } else {
              stopListeningUI();
            }
          } else {
            showError(result.error || 'Transcription failed');
            if (isContinuousMode) {
              listenLabel.textContent = 'Resuming...';
              setTimeout(() => startListening(true), 500);
            }
          }
        } catch (e) {
          showError('Transcription failed: ' + e.message);
          if (isContinuousMode) {
            listenLabel.textContent = 'Resuming...';
            setTimeout(() => startListening(true), 1500);
          }
        }
      } else {
        if (isContinuousMode) {
          listenLabel.textContent = 'Listening...';
          setTimeout(() => startListening(true), 300);
        } else {
          stopListeningUI();
        }
      }
    };

    mediaRecorder.start(500);

    isListening = true;
    btnListen.classList.add('active');
    listenLabel.textContent = 'Listening...';
    setStatus('listening', usingMicFallback
      ? 'System audio unavailable â€” microphone mode'
      : 'Listening for interviewer voice (system audio)...');
    audioMeter.style.display = 'flex';
    meterMic.style.width = '0%';

    let maxChunkTimeout = null;

    if (analyser) {
      // Adaptive noise-floor silence detection on the recorded stream
      let meterTick = 0;
      const baselineSamples = [];
      const listenStart = Date.now();
      let dynamicThreshold = 6;

      maxChunkTimeout = setTimeout(() => {
        if (isListening && hasSpeechStarted) stopListening(false);
      }, MAX_CHUNK_DURATION);

      function checkSilence() {
        if (!isListening) return;
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (!hasSpeechStarted && Date.now() - listenStart < CALIBRATION_MS) {
          baselineSamples.push(avg);
        } else if (baselineSamples.length > 0) {
          const baseline = baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;
          dynamicThreshold = Math.max(5, baseline * 2.5);
          baselineSamples.length = 0;
        }

        if (++meterTick % 6 === 0) {
          meterSys.style.width = Math.min(100, avg * 3) + '%';
          if (usingMicFallback) meterMic.style.width = Math.min(100, avg * 3) + '%';
        }

        if (avg > dynamicThreshold) {
          if (!hasSpeechStarted) {
            hasSpeechStarted = true;
            setStatus('listening', 'ðŸŽ¤ Question detected â€” listening...');
            listenLabel.textContent = 'Recording...';
          }
          clearTimeout(silenceTimeout);
          silenceTimeout = null;
        } else if (hasSpeechStarted && !silenceTimeout) {
          silenceTimeout = setTimeout(() => {
            if (isListening) stopListening(false);
          }, SILENCE_DURATION);
        }

        requestAnimationFrame(checkSilence);
      }
      checkSilence();
    } else {
      // No analyser â€” fixed 12s recording chunks
      console.warn('âš  Fixed-length recording mode (12s chunks)');
      maxChunkTimeout = setTimeout(() => {
        if (isListening) stopListening(false);
      }, 12000);
    }

  } catch (e) {
    console.error('Audio capture setup error:', e);
    setStatus('error', 'Audio capture error: ' + e.message);
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

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    cleanupAudio();
    stopListeningUI();
  }
}

function cleanupAudio() {
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function stopListeningUI() {
  isListening = false;
  btnListen.classList.remove('active');
  listenLabel.textContent = 'Start Listening';
  audioMeter.style.display = 'none';
}

// â”€â”€â”€ Process Question â†’ Generate Answer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function processQuestion(question) {
  if (!question) return;

  console.log(`Processing question: "${question}"`);
  showQuestion(question);
  showLoader();
  setStatus('thinking', 'Generating answer...');
  if (isContinuousMode) {
    listenLabel.textContent = 'Thinking...';
  }

  try {
    const result = await window.api.generateAnswer(question);
    console.log('Generate answer result:', { success: result.success, hasAnswer: !!result.answer });
    
    if (result.success) {
      if (isStreamingAnswer && answerTxt.textContent.length > 0) {
        loader.style.display = 'none';
        answerPH.style.display = 'none';
        answerTxt.style.display = 'block';
        isStreamingAnswer = false;
      } else {
        showAnswer(result.answer);
      }
      setStatus('ready', 'Answer ready âœ“');
      if (isContinuousMode) {
        listenLabel.textContent = 'Resuming...';
        setTimeout(() => startListening(true), 500);
      }
    } else {
      console.error('Answer generation failed:', result.error);
      showError(result.error);
      if (isContinuousMode) {
        listenLabel.textContent = 'Resuming...';
        setTimeout(() => startListening(true), 1000);
      }
    }
  } catch (e) {
    console.error('Answer generation exception:', e);
    showError('Failed to generate answer: ' + e.message);
    if (isContinuousMode) {
      listenLabel.textContent = 'Resuming...';
      setTimeout(() => startListening(true), 2000);
    }
  }
}

// â”€â”€â”€ Event Listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

btnListen.addEventListener('click', () => {
  if (isContinuousMode || isListening) {
    stopListening(true);
    setStatus('ready', 'Ready');
  } else {
    startListening();
  }
});

btnType.addEventListener('click', () => {
  const vis = manualInput.style.display === 'none';
  manualInput.style.display = vis ? 'flex' : 'none';
  if (vis) manualQ.focus();
});

btnSend.addEventListener('click', () => {
  const q = manualQ.value.trim();
  if (q) {
    manualQ.value = '';
    processQuestion(q);
  }
});
manualQ.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSend.click();
});

btnCopy.addEventListener('click', () => {
  const text = answerTxt.textContent;
  if (text && answerTxt.style.display !== 'none') {
    navigator.clipboard.writeText(text);
    btnCopy.textContent = 'âœ…';
    setTimeout(() => btnCopy.textContent = 'ðŸ“‹', 1500);
  }
});

btnSetup.addEventListener('click', () => window.api.showSetup());
btnClose.addEventListener('click', () => window.api.hideOverlay());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.hideOverlay();
});

// â”€â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.api.onAnswerChunk((chunk) => {
  if (loader.style.display !== 'none') {
    loader.style.display = 'none';
    answerPH.style.display = 'none';
    answerTxt.style.display = 'block';
    answerTxt.textContent = '';
    isStreamingAnswer = true;
  }
  answerTxt.textContent += chunk;
});

setStatus('ready', 'Ready â€” Click ðŸŽ¤ to capture interviewer audio');

window.addEventListener('DOMContentLoaded', () => {
  initMic().then(() => {
    setTimeout(() => {
      console.log('Auto-starting mock interview listener loop...');
      startListening();
    }, 1000);
  });
});
