// ─── DOM References ──────────────────────────────────────────
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

// ─── State ───────────────────────────────────────────────────
let isListening = false;
let isContinuousMode = false;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioContext = null;
let silenceTimeout = null;

// Real-time SpeechRecognition state
let recognition = null;
let speechRecSilenceTimeout = null;
let accumulatedTranscript = '';

// Microphone analysis for user voice filtering
let micStream = null;

// Track whether answer is currently streaming
let isStreamingAnswer = false;
let currentCycleProcessed = false;


// ─── Status Helpers ──────────────────────────────────────────
function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

// ─── UI Visual Handlers ──────────────────────────────────────
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
  answerTxt.textContent = '⚠️ ' + msg;
  setStatus('error', 'Error occurred');
  isStreamingAnswer = false;
}

// ─── Helpers ─────────────────────────────────────────────────
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

// ─── Microphone Init Helper ──────────────────────────────────
async function initMic() {
  try {
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('✓ Microphone initialized');
    }
  } catch (err) {
    console.warn('Microphone access not granted or failed:', err);
  }
}

// ─── Real-Time Speech Recognition (Web Speech API) ─────────────
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('SpeechRecognition API not supported in this Chromium version');
    return;
  }

  try {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript + ' ';
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      if (final) {
        accumulatedTranscript += final;
      }

      const displayPrompt = (accumulatedTranscript + ' ' + interim).trim();
      if (displayPrompt.length > 0) {
        showQuestion(displayPrompt);
        setStatus('listening', '🎤 Question detected — listening...');
        listenLabel.textContent = 'Recording...';
      }

      // Silence timer: if 1.8s of no new speech after capturing text, submit the question
      clearTimeout(speechRecSilenceTimeout);
      speechRecSilenceTimeout = setTimeout(() => {
        const fullQ = accumulatedTranscript.trim();
        if (fullQ.length > 5 && isListening && !currentCycleProcessed) {
          currentCycleProcessed = true;
          console.log(`✓ Web Speech Recognition detected question: "${fullQ}"`);
          accumulatedTranscript = '';
          processQuestion(fullQ);
        }
      }, 1800);
    };

    recognition.onerror = (event) => {
      console.warn('SpeechRecognition error:', event.error);
    };

    recognition.onend = () => {
      if (isListening && isContinuousMode) {
        try { recognition.start(); } catch (e) {}
      }
    };

    console.log('✓ Web Speech Recognition engine initialized');
  } catch (err) {
    console.warn('Failed to start SpeechRecognition:', err);
  }
}

function startSpeechRecognition() {
  if (recognition) {
    accumulatedTranscript = '';
    try {
      recognition.start();
      console.log('✓ Web Speech Recognition started');
    } catch (e) {
      // Already started or busy
    }
  }
}

function stopSpeechRecognition() {
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {}
  }
  clearTimeout(speechRecSilenceTimeout);
}

// ─── Audio Capture (System Audio + Microphone Merged Stream) ────
async function startListening(isAutoRestart = false) {
  if (isListening) return;
  currentCycleProcessed = false;
  if (!isAutoRestart) {
    isContinuousMode = true;
  }

  let sysAnalyser = null;
  let sysDataArray = null;
  let micAnalyserLocal = null;
  let micDataArrayLocal = null;
  let hasSpeechStarted = false;

  try {
    // 0. AudioContext — OPTIONAL. A broken audio device must never kill
    //    the capture flow; we fall back to direct-stream recording.
    let dest = null;
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') {
        await audioContext.resume().catch(() => {});
      }
      dest = audioContext.createMediaStreamDestination();
    } catch (ctxErr) {
      console.warn('AudioContext unavailable — using direct stream mode:', ctxErr);
      audioContext = null;
      dest = null;
    }

    let sysStream = null;

    // 1. Try capturing system desktop audio (interviewer voice)
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      displayStream.getVideoTracks().forEach((t) => t.stop());
      const sysAudioTracks = displayStream.getAudioTracks();
      if (sysAudioTracks.length > 0) {
        sysStream = new MediaStream(sysAudioTracks);
        if (audioContext && dest) {
          const sysSource = audioContext.createMediaStreamSource(sysStream);
          sysAnalyser = audioContext.createAnalyser();
          sysAnalyser.fftSize = 512;
          sysAnalyser.smoothingTimeConstant = 0.85;
          sysSource.connect(sysAnalyser);
          sysSource.connect(dest);
          sysDataArray = new Uint8Array(sysAnalyser.frequencyBinCount);
        }
        console.log('✓ System audio loopback captured');
      }
    } catch (sysErr) {
      console.warn('System audio loopback not available:', sysErr);
    }

    // 2. Capture microphone audio (picks up interviewer via laptop speakers)
    try {
      if (!micStream || !micStream.active) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (micStream && micStream.getAudioTracks().length > 0) {
        if (audioContext && dest) {
          const micSource = audioContext.createMediaStreamSource(micStream);
          micAnalyserLocal = audioContext.createAnalyser();
          micAnalyserLocal.fftSize = 512;
          micAnalyserLocal.smoothingTimeConstant = 0.85;
          micSource.connect(micAnalyserLocal);
          micSource.connect(dest);
          micDataArrayLocal = new Uint8Array(micAnalyserLocal.frequencyBinCount);
        }
        console.log('✓ Microphone input captured');
      }
    } catch (micErr) {
      console.warn('Microphone stream error:', micErr);
    }

    // 3. Pick the recording source
    if (audioContext && dest && dest.stream.getAudioTracks().length > 0) {
      audioStream = dest.stream;
    } else {
      // Direct mode — no AudioContext. Prefer system track, else mic.
      const directTracks = (sysStream && sysStream.getAudioTracks().length > 0)
        ? sysStream.getAudioTracks()
        : (micStream ? micStream.getAudioTracks() : []);
      if (directTracks.length === 0) {
        setStatus('error', 'No audio sources detected — please allow Microphone access');
        isContinuousMode = false;
        stopListeningUI();
        return;
      }
      audioStream = new MediaStream(directTracks);
      console.log('⚠ Direct stream mode (no analyser) — fixed-length recording');
    }

    const SILENCE_THRESHOLD = 2;
    const SILENCE_DURATION = 1800;
    const MAX_CHUNK_DURATION = 30000;

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

      const totalChunks = audioChunks.length;
      if (totalChunks === 0) {
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

      // Fallback transcription if Web Speech Recognition didn't already process it
      if (audioBlob.size >= 200 && !currentCycleProcessed) {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const base64Audio = arrayBufferToBase64(arrayBuffer);

        setStatus('thinking', '⚡ Transcribing question...');
        if (isContinuousMode) {
          listenLabel.textContent = 'Transcribing...';
        } else {
          stopListeningUI();
        }
        showLoader();

        try {
          const result = await window.api.transcribeAudio(base64Audio, actualMime);
          if (result.success && result.text) {
            const question = result.text.trim();
            if (question.length > 0) {
              currentCycleProcessed = true;
              processQuestion(question);
            } else {
              setStatus('listening', 'Listening for interview questions...');
              loader.style.display = 'none';
              if (isContinuousMode) {
                listenLabel.textContent = 'Listening...';
                startListening(true);
              } else {
                stopListeningUI();
              }
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
        // Audio too small or Web Speech already processed it
        if (isContinuousMode) {
          listenLabel.textContent = 'Listening...';
          setTimeout(() => startListening(true), 300);
        } else {
          stopListeningUI();
        }
      }
    };

    mediaRecorder.start(500);
    startSpeechRecognition();

    isListening = true;
    btnListen.classList.add('active');
    listenLabel.textContent = 'Listening...';
    setStatus('listening', 'Listening for interview questions...');
    audioMeter.style.display = 'flex';

    let maxChunkTimeout = null;

    if (sysAnalyser || micAnalyserLocal) {
      // Normal mode — silence detection via analysers
      let meterTick = 0;

      maxChunkTimeout = setTimeout(() => {
        if (isListening && hasSpeechStarted) {
          stopListening(false);
        }
      }, MAX_CHUNK_DURATION);

      function checkSilence() {
        if (!isListening) return;

        let avgSys = 0;
        if (sysAnalyser && sysDataArray) {
          sysAnalyser.getByteFrequencyData(sysDataArray);
          avgSys = sysDataArray.reduce((a, b) => a + b, 0) / sysDataArray.length;
        }

        let avgMic = 0;
        if (micAnalyserLocal && micDataArrayLocal) {
          micAnalyserLocal.getByteFrequencyData(micDataArrayLocal);
          avgMic = micDataArrayLocal.reduce((a, b) => a + b, 0) / micDataArrayLocal.length;
        }

        const maxCombinedVol = Math.max(avgSys, avgMic);

        if (++meterTick % 6 === 0) {
          meterSys.style.width = Math.min(100, avgSys * 3) + '%';
          meterMic.style.width = Math.min(100, avgMic * 3) + '%';
        }

        if (maxCombinedVol > SILENCE_THRESHOLD) {
          if (!hasSpeechStarted) {
            hasSpeechStarted = true;
            setStatus('listening', '🎤 Question detected — listening...');
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
      // Direct mode — no analysers. Record a fixed 12s chunk, transcribe it.
      console.log('⚠ Fixed-length recording mode (12s chunks)');
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
  stopSpeechRecognition();

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

// ─── Process Question → Generate Answer ──────────────────────
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
      setStatus('ready', 'Answer ready ✓');
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

// ─── Event Listeners ─────────────────────────────────────────

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
    btnCopy.textContent = '✅';
    setTimeout(() => btnCopy.textContent = '📋', 1500);
  }
});

btnSetup.addEventListener('click', () => window.api.showSetup());
btnClose.addEventListener('click', () => window.api.hideOverlay());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.hideOverlay();
});

// ─── Init ────────────────────────────────────────────────────
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

setStatus('ready', 'Ready — Click 🎤 to capture interviewer audio');

window.addEventListener('DOMContentLoaded', () => {
  initSpeechRecognition();
  initMic().then(() => {
    setTimeout(() => {
      console.log('Auto-starting mock interview listener loop...');
      startListening();
    }, 1000);
  });
});
