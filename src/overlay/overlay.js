const $ = (selector) => document.querySelector(selector);

const statusDot = $('#statusDot');
const statusText = $('#statusText');
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

const {
  AdaptiveSpeechDetector,
  downsampleBuffer,
  encodeWAV,
  isActionableQuestion,
  isConfidentVoiceAudio,
  isLikelyQuestion,
  mergeLiveTranscript,
  normalizeTranscript,
  questionsMatch,
  shouldFinalizeTrailingNoise,
  shouldRecoverCapture,
  shouldStartLiveAnswer,
} = window.InterviewAudio;

let isListening = false;
let isStarting = false;
let isContinuousMode = false;
let usingMicFallback = false;
let captureStream = null;
let captureGeneration = 0;
let audioContext = null;
let audioSource = null;
let audioNode = null;
let silentGain = null;
let analyser = null;
let frequencyData = null;
let isRecoveringCapture = false;
let captureRecoveryFailures = 0;
let captureHealthTimer = null;
let captureHealthCheckPending = false;
let deviceChangeTimer = null;
let captureStartedAt = 0;
let lastCaptureAudibleAt = 0;
let lastCaptureRecoveryAt = 0;
let captureHasAudio = false;
let captureOutputKey = '';
let trackMutedSince = 0;

const speechDetector = new AdaptiveSpeechDetector();
const preRollSamples = new Float32Array(4800);
const utteranceSamples = new Float32Array(16000 * 20);
let preRollCount = 0;
let preRollIndex = 0;
let utteranceCount = 0;
let utteranceActive = false;
let utteranceFinalizing = false;
let utteranceId = 0;
let utteranceStartedAt = 0;
let previewCount = 0;
let nextPreviewAt = 1200;
let previewInFlight = false;
let liveTranscript = '';
let previousPreview = '';
let stablePreviewCount = 0;
let earlyQuestion = '';
let earlyAnswerPromise = null;
let lastConfidentVoiceAt = 0;
let lastVoicedSampleCount = 0;

let isStreamingAnswer = false;
let isAnswerBusy = false;
let answerRequestSerial = 0;
let activeAnswerSerial = 0;
let pendingAnswerChunks = '';
let answerFlushFrame = null;
let meterFrame = 0;

function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

function showQuestion(text) {
  questionPH.style.display = 'none';
  questionTxt.style.display = 'block';
  questionTxt.textContent = text;
}

function flushAnswerChunks() {
  answerFlushFrame = null;
  if (!pendingAnswerChunks) return;
  answerTxt.textContent += pendingAnswerChunks;
  pendingAnswerChunks = '';
}

function scheduleAnswerFlush() {
  if (answerFlushFrame !== null) return;
  answerFlushFrame = requestAnimationFrame(flushAnswerChunks);
}

function showAnswer(text) {
  flushAnswerChunks();
  loader.style.display = 'none';
  answerPH.style.display = 'none';
  answerTxt.style.display = 'block';
  if (text && !isStreamingAnswer) answerTxt.textContent = text;
  isStreamingAnswer = false;
}

function showLoader() {
  answerBox.scrollTop = 0;
  answerPH.style.display = 'none';
  loader.style.display = 'flex';
  loader.querySelector('span').textContent = 'Generating answer...';
  if (!answerTxt.textContent) answerTxt.style.display = 'none';
  isStreamingAnswer = false;
  pendingAnswerChunks = '';
  if (answerFlushFrame !== null) cancelAnimationFrame(answerFlushFrame);
  answerFlushFrame = null;
}

function showError(message) {
  flushAnswerChunks();
  pendingAnswerChunks = '';
  loader.style.display = 'none';
  answerPH.style.display = 'none';
  answerTxt.style.display = 'block';
  answerTxt.textContent = 'Error: ' + message;
  setStatus('error', 'Error occurred');
  isStreamingAnswer = false;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function releaseCaptureStream() {
  if (!captureStream) return;
  captureStream.getTracks().forEach((track) => track.stop());
  captureStream = null;
}

function cleanupAudioGraph() {
  if (audioNode) {
    if (audioNode.port) audioNode.port.onmessage = null;
    else audioNode.onaudioprocess = null;
    audioNode.disconnect();
    audioNode = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (audioSource) {
    audioSource.disconnect();
    audioSource = null;
  }
  if (analyser) {
    analyser.disconnect();
    analyser = null;
  }
  frequencyData = null;
  if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
  audioContext = null;
}

function resetUtterance(preserveCalibration = true) {
  utteranceId++;
  speechDetector.reset(preserveCalibration);
  utteranceActive = false;
  utteranceFinalizing = false;
  utteranceCount = 0;
  utteranceStartedAt = 0;
  lastConfidentVoiceAt = 0;
  lastVoicedSampleCount = 0;
  previewCount = 0;
  nextPreviewAt = 1200;
  liveTranscript = '';
  previousPreview = '';
  stablePreviewCount = 0;
  earlyQuestion = '';
  earlyAnswerPromise = null;
}

function storePreRoll(samples) {
  for (let i = 0; i < samples.length; i++) {
    preRollSamples[preRollIndex] = samples[i];
    preRollIndex = (preRollIndex + 1) % preRollSamples.length;
  }
  preRollCount = Math.min(preRollSamples.length, preRollCount + samples.length);
}

function getOrderedPreRoll() {
  if (preRollCount < preRollSamples.length) return preRollSamples.slice(0, preRollCount);
  if (preRollIndex === 0) return preRollSamples.slice();
  const ordered = new Float32Array(preRollSamples.length);
  const tailLength = preRollSamples.length - preRollIndex;
  ordered.set(preRollSamples.subarray(preRollIndex), 0);
  ordered.set(preRollSamples.subarray(0, preRollIndex), tailLength);
  return ordered;
}

function beginUtterance() {
  const preRoll = getOrderedPreRoll();
  utteranceCount = Math.min(preRoll.length, utteranceSamples.length);
  utteranceSamples.set(preRoll.subarray(0, utteranceCount), 0);
  utteranceActive = true;
  utteranceFinalizing = false;
  utteranceStartedAt = Date.now();
  lastConfidentVoiceAt = utteranceStartedAt;
  lastVoicedSampleCount = utteranceCount;
  utteranceId++;
  previewCount = 0;
  nextPreviewAt = 1200;
  liveTranscript = '';
  previousPreview = '';
  stablePreviewCount = 0;
  earlyQuestion = '';
  earlyAnswerPromise = null;
  setStatus('listening', 'Interviewer speaking - recognizing live');
  listenLabel.textContent = 'Live...';
}

function appendUtteranceSamples(samples) {
  const count = Math.min(samples.length, utteranceSamples.length - utteranceCount);
  if (count > 0) utteranceSamples.set(samples.subarray(0, count), utteranceCount);
  utteranceCount += count;
}

function encodeUtterance() {
  const end = lastVoicedSampleCount > 0 ? Math.min(utteranceCount, lastVoicedSampleCount + 800) : utteranceCount;
  return encodeWAV(utteranceSamples.subarray(0, end), 16000);
}

async function previewUtterance(id) {
  if (previewInFlight || previewCount >= 2 || !utteranceActive || utteranceFinalizing) return;
  previewInFlight = true;
  previewCount++;
  nextPreviewAt += 1600;
  const base64Audio = arrayBufferToBase64(encodeUtterance());
  try {
    const result = await window.api.transcribeAudio(base64Audio, 'audio/wav', true);
    if (!isListening || id !== utteranceId || utteranceFinalizing || !result.success) return;
    const text = String(result.text || '').trim();
    if (!text) return;
    liveTranscript = mergeLiveTranscript(liveTranscript, text);
    showQuestion(liveTranscript + '...');
    const normalized = normalizeTranscript(liveTranscript);
    stablePreviewCount = normalized && normalized === normalizeTranscript(previousPreview) ? stablePreviewCount + 1 : 1;
    previousPreview = liveTranscript;
    if (!earlyQuestion && shouldStartLiveAnswer(liveTranscript, stablePreviewCount)) {
      earlyQuestion = liveTranscript;
      earlyAnswerPromise = processQuestion(liveTranscript, true);
    }
  } catch (error) {
    console.warn('Live transcription preview failed:', error);
  } finally {
    previewInFlight = false;
  }
}

async function finalizeUtterance(id) {
  if (!utteranceActive || utteranceFinalizing || id !== utteranceId) return;
  utteranceActive = false;
  utteranceFinalizing = true;
  speechDetector.reset(true);
  const durationMs = Date.now() - utteranceStartedAt;
  if (durationMs < 550 || utteranceCount < 1200) {
    resetUtterance();
    setStatus('listening', usingMicFallback ? 'Listening in microphone mode...' : 'Listening for interviewer voice...');
    listenLabel.textContent = 'Listening...';
    return;
  }

  const base64Audio = arrayBufferToBase64(encodeUtterance());
  setStatus('thinking', 'Finalizing live question...');
  listenLabel.textContent = 'Transcribing...';

  try {
    const result = await window.api.transcribeAudio(base64Audio, 'audio/wav', false);
    if (!isListening || id !== utteranceId) return;
    const finalText = String(result.success ? result.text || '' : '').trim();
    utteranceFinalizing = false;

    if (finalText && isLikelyQuestion(finalText)) {
      showQuestion(finalText);
      if (earlyQuestion && !questionsMatch(earlyQuestion, finalText)) {
        await processQuestion(finalText);
      } else if (earlyQuestion) {
        await earlyAnswerPromise;
      } else {
        await processQuestion(finalText);
      }
    } else if (earlyQuestion) {
      await earlyAnswerPromise;
    } else if (!result.success) {
      showError(result.error || 'Transcription failed');
    }
  } catch (error) {
    if (!isListening || id !== utteranceId) return;
    utteranceFinalizing = false;
    if (earlyQuestion) await earlyAnswerPromise;
    else showError('Transcription failed: ' + error.message);
  }

  if (isListening && id === utteranceId) {
    resetUtterance();
    if (!isAnswerBusy) {
      setStatus('listening', usingMicFallback ? 'Listening in microphone mode...' : 'Listening for interviewer voice...');
      listenLabel.textContent = 'Listening...';
    }
  }
}

function handleAudioBlock(rawSamples) {
  if (!isListening || !audioContext) return;
  const samples = downsampleBuffer(rawSamples, audioContext.sampleRate, 16000);
  const durationMs = rawSamples.length / audioContext.sampleRate * 1000;

  if (utteranceActive) appendUtteranceSamples(samples);
  else storePreRoll(samples);

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  const rmsDb = 20 * Math.log10(Math.sqrt(sumSquares / samples.length) || 1e-8);
  if (!usingMicFallback && rmsDb > -72) {
    captureHasAudio = true;
    lastCaptureAudibleAt = Date.now();
  }

  let zeroCrossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0) !== (samples[i] < 0)) zeroCrossings++;
  }
  const zeroCrossingRate = samples.length > 1 ? zeroCrossings / (samples.length - 1) : 0;

  let voiceEnergy = null;
  let highEnergy = null;
  if (analyser && frequencyData) {
    analyser.getByteFrequencyData(frequencyData);
    let voiceSum = 0;
    for (let i = 3; i <= 34; i++) voiceSum += frequencyData[i];
    voiceEnergy = voiceSum / 32;
    let highSum = 0;
    for (let i = 38; i < frequencyData.length; i++) highSum += frequencyData[i];
    highEnergy = highSum / (frequencyData.length - 38);
  }

  if (++meterFrame % 3 === 0) {
    const meterLevel = Math.max(0, Math.min(100, (rmsDb + 60) * 2.5));
    meterSys.style.width = meterLevel + '%';
    if (usingMicFallback) meterMic.style.width = meterLevel + '%';
  }

  const confidentVoice = isConfidentVoiceAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate);
  if (utteranceActive && confidentVoice) {
    lastConfidentVoiceAt = Date.now();
    lastVoicedSampleCount = utteranceCount;
  }

  const event = speechDetector.update(rmsDb, voiceEnergy, highEnergy, durationMs, zeroCrossingRate);
  if (event === 'start') {
    if (utteranceFinalizing && !confidentVoice) speechDetector.reset(true);
    else beginUtterance();
  } else if ((event === 'end' || event === 'limit') && utteranceActive) {
    void finalizeUtterance(utteranceId);
  } else if (shouldFinalizeTrailingNoise({
    now: Date.now(),
    lastConfidentVoiceAt,
    utteranceActive,
    utteranceFinalizing,
    durationMs: Date.now() - utteranceStartedAt,
  })) {
    void finalizeUtterance(utteranceId);
  } else if (utteranceActive && !utteranceFinalizing && Date.now() - utteranceStartedAt >= nextPreviewAt) {
    previewUtterance(utteranceId);
  }
}

async function getDefaultOutputKey() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((device) => device.kind === 'audiooutput');
    const defaultOutput = outputs.find((device) => device.deviceId === 'default') || outputs[0];
    return defaultOutput ? [defaultOutput.deviceId, defaultOutput.groupId, defaultOutput.label].filter(Boolean).join('|') : '';
  } catch (error) {
    return '';
  }
}

function startCaptureHealthMonitor() {
  if (captureHealthTimer !== null) return;
  captureHealthTimer = setInterval(() => void checkCaptureHealth(), 2000);
}

function stopCaptureHealthMonitor() {
  if (captureHealthTimer !== null) clearInterval(captureHealthTimer);
  captureHealthTimer = null;
  captureHealthCheckPending = false;
  if (deviceChangeTimer !== null) clearTimeout(deviceChangeTimer);
  deviceChangeTimer = null;
}

async function recoverCapture(reason, quiet = false) {
  if (!isContinuousMode || !isListening || isStarting || isRecoveringCapture) return;
  isRecoveringCapture = true;
  lastCaptureRecoveryAt = Date.now();
  captureGeneration++;
  isListening = false;
  cleanupAudioGraph();
  releaseCaptureStream();
  resetUtterance();
  trackMutedSince = 0;
  console.info('Reacquiring interview audio:', reason);
  if (!quiet) {
    setStatus('thinking', 'Reconnecting interview audio...');
    listenLabel.textContent = 'Reconnecting...';
  }
  try {
    await startListening(true);
    if (isListening) captureRecoveryFailures = 0;
  } finally {
    isRecoveringCapture = false;
  }
}

async function checkCaptureHealth() {
  if (!isContinuousMode || !isListening || isStarting || isRecoveringCapture || captureHealthCheckPending || !captureStream) return;
  captureHealthCheckPending = true;
  try {
    const track = captureStream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      void recoverCapture('interview audio track ended');
      return;
    }
    if (usingMicFallback) return;

    if (track.muted) {
      if (!trackMutedSince) trackMutedSince = Date.now();
      else if (Date.now() - trackMutedSince >= 1500) {
        void recoverCapture('interview audio track muted');
        return;
      }
    } else {
      trackMutedSince = 0;
    }

    const outputKey = await getDefaultOutputKey();
    if (!isListening || usingMicFallback) return;
    if (!captureOutputKey && outputKey) {
      captureOutputKey = outputKey;
    } else if (captureOutputKey && outputKey && outputKey !== captureOutputKey) {
      void recoverCapture('Windows default audio output changed');
      return;
    }

    if (shouldRecoverCapture({
      now: Date.now(),
      startedAt: captureStartedAt,
      lastAudibleAt,
      heardAudio: captureHasAudio,
      recovering: isRecoveringCapture,
      utteranceActive,
      lastRecoveryAt,
    })) {
      void recoverCapture('system audio stayed silent', true);
    }
  } finally {
    captureHealthCheckPending = false;
  }
}

function scheduleDeviceChangeRecovery() {
  if (!isContinuousMode || !isListening || usingMicFallback || isRecoveringCapture) return;
  if (deviceChangeTimer !== null) clearTimeout(deviceChangeTimer);
  deviceChangeTimer = setTimeout(() => {
    deviceChangeTimer = null;
    void recoverCapture('audio device changed');
  }, 800);
}

async function setupAudioGraph(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (audioContext.state === 'suspended') await audioContext.resume();
  audioSource = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  audioSource.connect(analyser);
  frequencyData = new Uint8Array(analyser.frequencyBinCount);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  silentGain.connect(audioContext.destination);

  try {
    await audioContext.audioWorklet.addModule(new URL('./pcm-recorder-worklet.js', window.location.href).href);
    audioNode = new AudioWorkletNode(audioContext, 'pcm-recorder');
    audioNode.port.onmessage = (event) => handleAudioBlock(event.data);
  } catch (error) {
    console.warn('AudioWorklet unavailable, using audio processing fallback:', error);
    audioNode = audioContext.createScriptProcessor(2048, 1, 1);
    audioNode.onaudioprocess = (event) => handleAudioBlock(event.inputBuffer.getChannelData(0));
  }

  audioSource.connect(audioNode);
  audioNode.connect(silentGain);
}

async function ensureCaptureStream() {
  if (captureStream && captureStream.getAudioTracks().some((track) => track.readyState === 'live')) return captureStream;
  releaseCaptureStream();
  usingMicFallback = false;
  let loopbackError = null;

  for (let attempt = 0; attempt < 2 && !captureStream; attempt++) {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      displayStream.getVideoTracks().forEach((track) => { track.enabled = false; });
      const track = displayStream.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') {
        displayStream.getTracks().forEach((streamTrack) => streamTrack.stop());
        throw new Error('Windows did not provide a live system audio track');
      }
      captureStream = displayStream;
    } catch (error) {
      loopbackError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  if (!captureStream) {
    console.warn('System audio capture failed, trying microphone fallback:', loopbackError);
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    captureStream = micStream;
    usingMicFallback = true;
  }

  const track = captureStream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') {
    releaseCaptureStream();
    throw new Error('No live audio capture track is available');
  }
  track.addEventListener('ended', () => {
    if (!isListening || track !== captureStream?.getAudioTracks()[0]) return;
    void recoverCapture('interview audio track ended');
  }, { once: true });
  track.addEventListener('mute', () => {
    if (track === captureStream?.getAudioTracks()[0] && !usingMicFallback) trackMutedSince = Date.now();
  });
  track.addEventListener('unmute', () => {
    if (track === captureStream?.getAudioTracks()[0]) trackMutedSince = 0;
  });
  return captureStream;
}

async function startListening(isAutoRestart = false) {
  if (isListening || isStarting) return;
  isStarting = true;
  if (!isAutoRestart) isContinuousMode = true;
  const generation = ++captureGeneration;

  try {
    const stream = await ensureCaptureStream();
    if (generation !== captureGeneration || !isContinuousMode) {
      if (captureStream) releaseCaptureStream();
      return;
    }
    await setupAudioGraph(stream);
    if (generation !== captureGeneration || !isContinuousMode) {
      cleanupAudioGraph();
      releaseCaptureStream();
      return;
    }
    captureOutputKey = await getDefaultOutputKey();
    if (generation !== captureGeneration || !isContinuousMode) {
      cleanupAudioGraph();
      releaseCaptureStream();
      return;
    }
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      throw new Error('Interview audio disconnected during setup');
    }
    captureStartedAt = Date.now();
    lastCaptureAudibleAt = captureStartedAt;
    captureHasAudio = false;
    trackMutedSince = 0;
    captureRecoveryFailures = 0;
    resetUtterance(false);
    isListening = true;
    btnListen.classList.add('active');
    listenLabel.textContent = 'Listening...';
    audioMeter.style.display = 'flex';
    meterMic.style.width = '0%';
    startCaptureHealthMonitor();
    setStatus('listening', usingMicFallback ? 'Microphone fallback - interviewer audio may be limited' : 'Listening for interviewer voice...');
  } catch (error) {
    console.error('Audio capture setup error:', error);
    cleanupAudioGraph();
    releaseCaptureStream();
    if (isAutoRestart && isContinuousMode && captureRecoveryFailures < 3) {
      captureRecoveryFailures++;
      stopListeningUI();
      setStatus('error', 'Audio reconnect failed - retrying...');
      setTimeout(() => {
        if (isContinuousMode && !isListening && !isStarting) void startListening(true);
      }, 1500);
    } else {
      isContinuousMode = false;
      stopListeningUI();
      setStatus('error', 'Audio capture failed: ' + error.message);
    }
  } finally {
    isStarting = false;
  }
}

function stopListening(isManual = false) {
  if (isManual) isContinuousMode = false;
  isListening = false;
  isStarting = false;
  captureGeneration++;
  stopCaptureHealthMonitor();
  cleanupAudioGraph();
  releaseCaptureStream();
  resetUtterance();
  stopListeningUI();
  setStatus('ready', 'Ready');
}

function stopListeningUI() {
  isListening = false;
  btnListen.classList.remove('active');
  listenLabel.textContent = 'Start Listening';
  audioMeter.style.display = 'none';
}

async function processQuestion(question, live = false) {
  if (!question) return;
  const requestId = ++answerRequestSerial;
  activeAnswerSerial = requestId;
  isAnswerBusy = true;
  console.log(`Processing ${live ? 'live' : 'final'} question: "${question}"`);
  showQuestion(question + (live ? '...' : ''));
  showLoader();
  setStatus('thinking', live ? 'Answering while interviewer speaks...' : 'Generating answer...');
  listenLabel.textContent = 'Thinking...';

  try {
    const result = await window.api.generateAnswer(question, (chunk) => {
      if (requestId !== activeAnswerSerial || !chunk) return;
      if (!isStreamingAnswer) {
        answerTxt.textContent = '';
        answerTxt.style.display = 'block';
        isStreamingAnswer = true;
      }
      loader.style.display = 'none';
      answerPH.style.display = 'none';
      pendingAnswerChunks += chunk;
      scheduleAnswerFlush();
    });

    if (requestId !== activeAnswerSerial) return;
    flushAnswerChunks();
    if (result.success) {
      if (isStreamingAnswer && answerTxt.textContent.length > 0) {
        loader.style.display = 'none';
        answerPH.style.display = 'none';
        answerTxt.style.display = 'block';
        isStreamingAnswer = false;
      } else {
        showAnswer(result.answer);
      }
      setStatus('ready', 'Answer ready - still listening');
      if (!isListening) listenLabel.textContent = 'Start Listening';
    } else {
      showError(result.error || 'Answer generation failed');
    }
  } catch (error) {
    if (requestId !== activeAnswerSerial) return;
    showError('Failed to generate answer: ' + error.message);
  } finally {
    if (requestId === activeAnswerSerial) isAnswerBusy = false;
  }
}

btnListen.addEventListener('click', () => {
  if (isContinuousMode || isListening || isStarting) {
    stopListening(true);
  } else {
    startListening();
  }
});

btnType.addEventListener('click', () => {
  const visible = manualInput.style.display === 'none';
  manualInput.style.display = visible ? 'flex' : 'none';
  if (visible) manualQ.focus();
});

btnSend.addEventListener('click', () => {
  const question = manualQ.value.trim();
  if (!question) return;
  manualQ.value = '';
  processQuestion(question);
});

manualQ.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') btnSend.click();
});

btnCopy.addEventListener('click', () => {
  const text = answerTxt.textContent;
  if (text && answerTxt.style.display !== 'none') {
    navigator.clipboard.writeText(text);
    btnCopy.textContent = 'Copied';
    setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
  }
});

btnSetup.addEventListener('click', () => window.api.showSetup());
btnClose.addEventListener('click', () => window.api.hideOverlay());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.api.hideOverlay();
});

navigator.mediaDevices.addEventListener('devicechange', scheduleDeviceChangeRecovery);

setStatus('ready', 'Ready');

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => startListening(), 300);
});
