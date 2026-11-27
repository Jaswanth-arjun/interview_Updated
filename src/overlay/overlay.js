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
  extractLiveQuestionPreview,
  extractQuestionCore,
  isActionableQuestion,
  isConfidentVoiceAudio,
  isLikelyQuestion,
  isVoiceLikeAudio,
  hasEnoughSpeechEvidence,
  mergeLiveTranscript,
  normalizeTranscript,
  prepareAudioForTranscription,
  questionsMatch,
  shouldFinalizeTrailingNoise,
  shouldRecoverCapture,
  shouldStartLiveAnswer,
  stripDiscoursePrefix,
  stripNoiseTags,
} = window.InterviewAudio;

let isListening = false;
let isStarting = false;
let isContinuousMode = false;
let usingMicFallback = false;
let hasUserStartedCapture = false;
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

// A question is only considered finished after ~800 ms of real silence. The
// old 340 ms cut point frequently split one question into two fragments, which
// then looked like the app had "detected a different question".
const speechDetector = new AdaptiveSpeechDetector({
  minSpeechMs: 90,
  silenceMs: 700,
  maxUtteranceMs: 24000,
  // Shorter calibration so a question is picked up sooner after the
  // interviewer starts talking.
  calibrationMs: 220,
});

// 600 ms of pre-roll at 16 kHz so the first word of a question is never lost.
const preRollSamples = new Float32Array(9600);
const UTTERANCE_SAMPLES = 16000 * 30;
let preRollCount = 0;
let preRollIndex = 0;

let activeUtterance = null;
let utteranceSerial = 0;
let latestAnsweredUtteranceId = 0;
let lastAnsweredQuestion = '';
let lastSuccessfulQuestion = '';
let lastAnsweredAt = 0;
// Snapshot of the last successfully generated Q&A. Noise from the
// interviewer's side must never leave the panel empty, so we restore this
// when a noise-triggered request fails.
let lastGoodAnswer = null;

let isStreamingAnswer = false;
let isAnswerBusy = false;
let answerRequestSerial = 0;
let activeAnswerSerial = 0;
let activeAnswerUtteranceId = 0;
let pendingAnswerChunks = '';
let answerFlushFrame = null;
let meterFrame = 0;

function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

function restoreListeningStatus() {
  if (!isListening || isAnswerBusy) return;
  setStatus('listening', usingMicFallback
    ? 'Microphone fallback - use system audio for headphones'
    : 'Listening to interviewer voice...');
  listenLabel.textContent = 'Listening...';
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

// Prepare the answer panel for a new request. The panel never shows a loading
// state: either the previous answer stays exactly as it is, or the placeholder
// stays until the first real sentence of the new answer arrives.
function prepareAnswerForRequest() {
  flushAnswerChunks();
  if (answerFlushFrame !== null) cancelAnimationFrame(answerFlushFrame);
  answerFlushFrame = null;
  pendingAnswerChunks = '';
  isStreamingAnswer = false;
  loader.style.display = 'none';
  if (hasVisibleAnswer()) return;
  answerBox.scrollTop = 0;
  answerPH.style.display = 'block';
  answerTxt.style.display = 'none';
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

function hasVisibleAnswer() {
  const text = (answerTxt.textContent || '').trim();
  return !!text && answerTxt.style.display !== 'none' && !text.startsWith('Error:');
}

// A generated answer is always a couple of full sentences. Anything shorter
// that has no sentence break is treated as a failed/truncated decode, so it
// can never overwrite a good answer that is already on screen.
function looksLikeRealAnswer(text) {
  const value = (text || '').trim();
  if (!value) return false;
  return value.length >= 40 || /[.!?]/.test(value);
}

function rememberGoodAnswer(question) {
  const answer = (answerTxt.textContent || '').trim();
  if (!answer || answer.startsWith('Error:')) return;
  lastGoodAnswer = { question, answer };
}

// A noise-only utterance must never leave the panel blank. Put the last
// verified Q&A back exactly as the user saw it. When a newer question is
// already being shown live, keep that question and restore only the answer so
// the panel does not jump back to the previous question mid-sentence.
function restoreLastGoodAnswer({ keepQuestion = false } = {}) {
  if (!lastGoodAnswer) return false;
  const liveQuestionOnScreen = (questionTxt.textContent || '').trim().endsWith('...');
  if (!keepQuestion && !liveQuestionOnScreen) {
    questionPH.style.display = 'none';
    questionTxt.style.display = 'block';
    questionTxt.textContent = lastGoodAnswer.question;
  }
  answerPH.style.display = 'none';
  answerTxt.style.display = 'block';
  answerTxt.textContent = lastGoodAnswer.answer;
  loader.style.display = 'none';
  isStreamingAnswer = false;
  pendingAnswerChunks = '';
  if (answerFlushFrame !== null) cancelAnimationFrame(answerFlushFrame);
  answerFlushFrame = null;
  return true;
}

function isFragmentOfShownQuestion(text) {
  const normalized = normalizeTranscript(text);
  const shown = normalizeTranscript(questionTxt.textContent || '');
  if (!normalized || !shown || normalized === shown) return false;
  if (normalized.length < 6) return false;
  return shown.includes(normalized);
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

function createUtterance() {
  const now = Date.now();
  return {
    id: ++utteranceSerial,
    captureGeneration,
    samples: new Float32Array(UTTERANCE_SAMPLES),
    count: 0,
    startedAt: now,
    lastVoicedAt: now,
    lastVoicedCount: 0,
    voicedMs: 0,
    confidentVoicedMs: 0,
    modulatedVoicedMs: 0,
    lastBlockRmsDb: null,
    previewCount: 0,
    // First preview fires as soon as there is speech evidence, then roughly
    // every 320 ms. Waiting longer put the live answer 1-2 s behind the
    // interviewer; the final decode still corrects the wording afterwards.
    nextPreviewAt: 80,
    previewInFlight: false,
    liveTranscript: '',
    previousPreview: '',
    stablePreviewCount: 0,
    earlyQuestion: '',
    earlyAnswerPromise: null,
    earlyQuestionRefreshed: false,
    finalizing: false,
  };
}

function clearUtteranceState() {
  activeUtterance = null;
  speechDetector.reset(false);
  preRollCount = 0;
  preRollIndex = 0;
}

function storePreRoll(samples) {
  for (let i = 0; i < samples.length; i++) {
    preRollSamples[preRollIndex] = samples[i];
    preRollIndex = (preRollIndex + 1) % preRollSamples.length;
  }
  preRollCount = Math.min(preRollSamples.length, preRollCount + samples.length);
}

function getOrderedPreRoll() {
  if (preRollCount <= 0) return new Float32Array(0);
  if (preRollCount < preRollSamples.length) return preRollSamples.slice(0, preRollCount);
  if (preRollIndex === 0) return preRollSamples.slice();
  const ordered = new Float32Array(preRollSamples.length);
  const tailLength = preRollSamples.length - preRollIndex;
  ordered.set(preRollSamples.subarray(preRollIndex), 0);
  ordered.set(preRollSamples.subarray(0, preRollIndex), tailLength);
  return ordered;
}

function beginUtterance() {
  if (activeUtterance) return;
  const utterance = createUtterance();
  const preRoll = getOrderedPreRoll();
  utterance.count = Math.min(preRoll.length, utterance.samples.length);
  if (utterance.count > 0) utterance.samples.set(preRoll.subarray(0, utterance.count), 0);
  utterance.lastVoicedCount = utterance.count;
  activeUtterance = utterance;
  setStatus('listening', 'Interviewer speaking - listening live...');
  listenLabel.textContent = 'Live...';
}

function appendUtteranceSamples(utterance, samples) {
  const count = Math.min(samples.length, utterance.samples.length - utterance.count);
  if (count > 0) utterance.samples.set(samples.subarray(0, count), utterance.count);
  utterance.count += count;
}

function encodeUtterance(utterance) {
  const tailSamples = 4800; // 300 ms of natural tail so the last word is not clipped
  const end = utterance.lastVoicedCount > 0
    ? Math.min(utterance.count, utterance.lastVoicedCount + tailSamples)
    : utterance.count;
  const slice = utterance.samples.subarray(0, Math.max(1, end));
  const prepared = prepareAudioForTranscription(slice, 16000);
  return encodeWAV(prepared.length ? prepared : slice, 16000);
}

// A question word anywhere in the partial means the interviewer has started
// asking. Showing the text from that point is what makes the question appear
// while they are still speaking instead of after they finish.
const LIVE_QUESTION_CUE = /\b(what|why|how|when|where|which|who|can|could|would|should|do|does|did|tell|describe|explain|walk|share|talk|give|discuss)\b/i;

function looksLikeQuestionInProgress(text) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return false;
  if (normalized.split(' ').filter(Boolean).length < 4) return false;
  return LIVE_QUESTION_CUE.test(normalized);
}

function updateLiveQuestion(utterance, merged) {
  // Show the question while it is being spoken: no stability wait. The text
  // starts as a partial and is refined by each following preview.
  const previewText = extractLiveQuestionPreview(merged)
    || (looksLikeQuestionInProgress(merged) ? stripDiscoursePrefix(merged) : '');
  if (!previewText) return;
  showQuestion(previewText + (utterance.earlyQuestion ? '' : '...'));
}

async function previewUtterance(utterance) {
  if (utterance.previewInFlight) return;
  if (!isListening || utterance !== activeUtterance || utterance.finalizing) return;
  if (utterance.captureGeneration !== captureGeneration) return;
  // Long questions keep updating on screen: ~10 s of speech stays live.
  if (utterance.previewCount >= 18) return;

  utterance.previewInFlight = true;
  utterance.previewCount++;
  const base64Audio = arrayBufferToBase64(encodeUtterance(utterance));

  try {
    const result = await window.api.transcribeAudio(base64Audio, 'audio/wav', true);
    if (!isListening || utterance !== activeUtterance || utterance.finalizing) return;
    if (utterance.captureGeneration !== captureGeneration || !result.success) return;

    const text = stripDiscoursePrefix(stripNoiseTags(result.text || ''));
    if (!text) return;
    // The display may start as soon as a question is forming; answering still
    // requires the stricter isActionableQuestion gate further below.
    if (!isLikelyQuestion(text) && !looksLikeQuestionInProgress(text)) return;

    const merged = mergeLiveTranscript(utterance.liveTranscript, text);
    const normalized = normalizeTranscript(merged);
    const previousNormalized = normalizeTranscript(utterance.previousPreview);
    if (!normalized) return;

    const previousWords = previousNormalized.split(' ').filter(Boolean);
    const currentWords = normalized.split(' ').filter(Boolean);
    let shared = 0;
    while (shared < previousWords.length && shared < currentWords.length && previousWords[shared] === currentWords[shared]) shared++;
    const stable = previousNormalized.length > 0 && (shared >= Math.min(3, Math.min(previousWords.length, currentWords.length)) || normalized.includes(previousNormalized) || previousNormalized.includes(normalized));
    utterance.stablePreviewCount = stable ? utterance.stablePreviewCount + 1 : 0;
    utterance.previousPreview = merged;
    utterance.liveTranscript = merged;

    updateLiveQuestion(utterance, merged);

    // Require real speech evidence before a partial preview can replace the
    // answer on screen. Coughs/taps can produce an occasional stable-looking
    // hallucination, but they do not carry this much voice energy.
    const speechEvidence = hasEnoughSpeechEvidence({
      voicedMs: utterance.voicedMs,
      confidentVoicedMs: utterance.confidentVoicedMs,
      modulatedVoicedMs: utterance.modulatedVoicedMs,
      live: true,
    });
    // Starting the first answer must be fast. Replacing an answer that is
    // already on screen needs a little more evidence, so a cough or a short
    // background remark between questions cannot wipe it.
    const replacingAnswerOnScreen = hasVisibleAnswer();
    const allowFirstPreview = replacingAnswerOnScreen
      ? (utterance.confidentVoicedMs >= 420 || utterance.modulatedVoicedMs >= 520)
      : (utterance.confidentVoicedMs >= 250 || utterance.modulatedVoicedMs >= 320);
    if (!utterance.earlyQuestion && speechEvidence && shouldStartLiveAnswer(merged, utterance.stablePreviewCount, allowFirstPreview)) {
      utterance.earlyQuestion = stripDiscoursePrefix(merged);
      utterance.earlyAnswerPromise = processQuestion(utterance.earlyQuestion, true, utterance.id);
    } else if (utterance.earlyQuestion && !utterance.earlyQuestionRefreshed) {
      // The interviewer kept adding to the question after the live answer
      // started. Once it has grown by a meaningful clause, answer the fuller
      // question instead of keeping an answer to a half-sentence.
      const earlyCore = extractQuestionCore(utterance.earlyQuestion) || utterance.earlyQuestion;
      const liveCore = extractQuestionCore(merged) || merged;
      if (questionExtensionWords(earlyCore, liveCore) >= 2) {
        utterance.earlyQuestionRefreshed = true;
        utterance.earlyQuestion = stripDiscoursePrefix(merged);
        utterance.earlyAnswerPromise = processQuestion(utterance.earlyQuestion, true, utterance.id);
      }
    }
  } catch (error) {
    console.warn('Live transcription preview failed:', error);
  } finally {
    utterance.previewInFlight = false;
    const elapsed = Date.now() - utterance.startedAt;
    utterance.nextPreviewAt = elapsed + (utterance.previewCount < 10 ? 300 : 900);
  }
}

// Words that do not change the meaning of a question. Used to decide whether
// the finalized question added real content that the live answer must cover.
const EXTENSION_FILLERS = new Set([
  'and', 'or', 'but', 'so', 'that', 'the', 'a', 'an', 'to', 'of', 'with', 'for',
  'about', 'in', 'on', 'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'can', 'could', 'would', 'will', 'should', 'please',
  'your', 'my', 'our', 'their', 'you', 'we', 'they', 'it', 'this', 'these',
  'those', 'then', 'also', 'just', 'really', 'very', 'like', 'me', 'us', 'i',
  'there', 'here', 'now', 'today', 'okay', 'ok', 'right', 'well', 'um', 'uh',
]);

function questionExtensionWords(early, final) {
  const earlyText = normalizeTranscript(early);
  const finalText = normalizeTranscript(final);
  if (!earlyText || !finalText || !finalText.startsWith(earlyText + ' ')) return 0;
  return finalText
    .slice(earlyText.length + 1)
    .split(' ')
    .filter((word) => word && !EXTENSION_FILLERS.has(word))
    .length;
}

async function finalizeUtterance(utterance, reason = 'end') {
  if (!utterance || utterance.finalizing) return;
  utterance.finalizing = true;

  // Ignore coughs, keyboard taps and steady noise before spending a
  // transcription request. Live answers already passed this stricter gate.
  if (!hasEnoughSpeechEvidence({
    voicedMs: utterance.voicedMs,
    confidentVoicedMs: utterance.confidentVoicedMs,
    modulatedVoicedMs: utterance.modulatedVoicedMs,
  })) {
    utterance.finalizing = false;
    restoreListeningStatus();
    return;
  }
  if (utterance.captureGeneration !== captureGeneration || !isListening) {
    utterance.finalizing = false;
    return;
  }
  // A newer question has already been finalized and is on screen. Finishing
  // this older utterance now would only overwrite that correct Q&A.
  if (utterance.id < latestAnsweredUtteranceId) {
    utterance.finalizing = false;
    restoreListeningStatus();
    return;
  }

  const base64Audio = arrayBufferToBase64(encodeUtterance(utterance));
  setStatus('thinking', utterance.earlyQuestion ? 'Verifying question...' : 'Finalizing question...');
  listenLabel.textContent = 'Transcribing...';

  try {
    // Final transcription always uses the complete utterance, not a partial.
    const result = await window.api.transcribeAudio(base64Audio, 'audio/wav', false);
    if (!isListening || utterance.captureGeneration !== captureGeneration) return;

    const finalText = result.success ? stripDiscoursePrefix(stripNoiseTags(result.text || '')) : '';
    const usable = finalText && isActionableQuestion(finalText);

    if (usable) {
      showQuestion(extractQuestionCore(finalText) || finalText);
      if (utterance.earlyQuestion) {
        const earlyWords = normalizeTranscript(utterance.earlyQuestion).split(' ').filter(Boolean).length;
        const finalWords = normalizeTranscript(finalText).split(' ').filter(Boolean).length;
        if (questionsMatch(utterance.earlyQuestion, finalText)) {
          const extraWords = questionExtensionWords(utterance.earlyQuestion, finalText);
          const earlyStarted = utterance.earlyAnswerPromise ? await utterance.earlyAnswerPromise : false;
          const earlyAnswered = earlyStarted && lastSuccessfulQuestion
            && questionsMatch(lastSuccessfulQuestion, utterance.earlyQuestion);
          if (!earlyAnswered || extraWords >= 1) {
            // Either there is no answer for the early wording (it was
            // suppressed/blocked), or the final wording added real content.
            // Generate from the complete final question.
            await processQuestion(finalText, false, utterance.id);
          } else if (earlyWords - finalWords >= 3) {
            // The final decode dropped words the verified partial had. Keep
            // the more complete early question instead of replacing a correct
            // question with a truncated one.
            showQuestion(extractQuestionCore(utterance.earlyQuestion) || utterance.earlyQuestion);
          } else {
            showQuestion(extractQuestionCore(finalText) || finalText);
          }
        } else {
          // The final question is materially different from the partial one.
          // Replace the answer so the user never keeps an answer to a
          // mis-detected partial question.
          await processQuestion(finalText, false, utterance.id);
        }
      } else {
        await processQuestion(finalText, false, utterance.id);
      }
    } else if (utterance.earlyQuestion) {
      // A weak or noisy final decode must never wipe a verified live answer.
      // The early answer was already accepted only after stable partials plus
      // real speech evidence, so keep it on screen.
      const earlyStarted = utterance.earlyAnswerPromise ? await utterance.earlyAnswerPromise : false;
      const earlyAnswered = earlyStarted && lastSuccessfulQuestion
        && questionsMatch(lastSuccessfulQuestion, utterance.earlyQuestion);
      if (earlyAnswered) {
        const earlyCore = extractQuestionCore(utterance.earlyQuestion) || utterance.earlyQuestion;
        showQuestion(earlyCore);
        rememberGoodAnswer(earlyCore);
        setStatus('ready', 'Answer ready - still listening');
      } else if (!restoreLastGoodAnswer({ keepQuestion: true })) {
        setStatus('listening', 'Audio unclear - still listening...');
      }
    } else if (!result.success) {
      // Noise on the interviewer side must not erase the answer on screen.
      console.warn('Ignoring failed background transcription:', result.error || 'unknown');
      if (!restoreLastGoodAnswer() && !hasVisibleAnswer()) {
        setStatus('listening', 'Audio unclear - still listening...');
      }
    } else {
      // No valid question in this audio. Do not display random background text.
      console.info('Ignored transcript that was not an interview question:', finalText || '(empty)', reason);
    }
  } catch (error) {
    if (!isListening) return;
    if (utterance.earlyQuestion) {
      await utterance.earlyAnswerPromise;
      return;
    }
    if (!restoreLastGoodAnswer() && !hasVisibleAnswer()) {
      setStatus('listening', 'Audio unclear - still listening...');
    }
  } finally {
    utterance.finalizing = false;
    if (isListening && !activeUtterance) restoreListeningStatus();
  }
}

function handleAudioBlock(rawSamples) {
  if (!isListening || !audioContext) return;
  const samples = downsampleBuffer(rawSamples, audioContext.sampleRate, 16000);
  const durationMs = (rawSamples.length / audioContext.sampleRate) * 1000;
  if (!samples.length) return;

  if (activeUtterance) appendUtteranceSamples(activeUtterance, samples);
  else storePreRoll(samples);

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  const rmsDb = 20 * Math.log10(Math.sqrt(sumSquares / samples.length) || 1e-8);
  if (rmsDb > -78) {
    lastCaptureAudibleAt = Date.now();
    if (!usingMicFallback) captureHasAudio = true;
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
    highEnergy = highSum / Math.max(1, frequencyData.length - 38);
  }

  if (++meterFrame % 3 === 0) {
    const meterLevel = Math.max(0, Math.min(100, (rmsDb + 60) * 2.5));
    meterSys.style.width = meterLevel + '%';
    if (usingMicFallback) meterMic.style.width = meterLevel + '%';
  }

  const voiceLike = isVoiceLikeAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate);
  const confidentVoice = isConfidentVoiceAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate);
  if (activeUtterance) {
    const previousRmsDb = activeUtterance.lastBlockRmsDb;
    const rmsDelta = Number.isFinite(previousRmsDb) ? Math.abs(rmsDb - previousRmsDb) : 0;
    if (voiceLike && rmsDelta >= 2 && rmsDelta <= 18) {
      activeUtterance.modulatedVoicedMs += durationMs;
    }
    activeUtterance.lastBlockRmsDb = rmsDb;
  }
  if (activeUtterance && confidentVoice) {
    activeUtterance.confidentVoicedMs += durationMs;
  }
  if (activeUtterance && (voiceLike || confidentVoice)) {
    activeUtterance.lastVoicedAt = Date.now();
    activeUtterance.lastVoicedCount = activeUtterance.count;
    activeUtterance.voicedMs += durationMs;
  }

  const event = speechDetector.update(rmsDb, voiceEnergy, highEnergy, durationMs, zeroCrossingRate);
  if (event === 'start') {
    beginUtterance();
  } else if ((event === 'end' || event === 'limit') && activeUtterance) {
    const utterance = activeUtterance;
    activeUtterance = null;
    speechDetector.reset(true);
    void finalizeUtterance(utterance, event);
  } else if (activeUtterance && shouldFinalizeTrailingNoise({
    now: Date.now(),
    lastConfidentVoiceAt: activeUtterance.lastVoicedAt,
    utteranceActive: !!activeUtterance,
    utteranceFinalizing: activeUtterance.finalizing,
    durationMs: Date.now() - activeUtterance.startedAt,
    minDurationMs: 500,
    // Only used when background noise keeps the RMS above the silence
    // threshold. 1.8 s is long enough not to split a natural pause.
    trailingNoiseMs: 1800,
  })) {
    const utterance = activeUtterance;
    activeUtterance = null;
    speechDetector.reset(true);
    void finalizeUtterance(utterance, 'trailing-noise');
  } else if (activeUtterance && !activeUtterance.finalizing && activeUtterance.liveTranscript.trim().endsWith('?')
    && speechDetector.silenceDurationMs >= 450) {
    const utterance = activeUtterance;
    activeUtterance = null;
    speechDetector.reset(true);
    void finalizeUtterance(utterance, 'complete-question');
  } else if (activeUtterance && !activeUtterance.finalizing && hasEnoughSpeechEvidence({
    voicedMs: activeUtterance.voicedMs,
    confidentVoicedMs: activeUtterance.confidentVoicedMs,
    modulatedVoicedMs: activeUtterance.modulatedVoicedMs,
    live: true,
  })) {
    const elapsed = Date.now() - activeUtterance.startedAt;
    if (elapsed >= activeUtterance.nextPreviewAt) void previewUtterance(activeUtterance);
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
  clearUtteranceState();
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
      lastAudibleAt: lastCaptureAudibleAt,
      heardAudio: captureHasAudio,
      recovering: isRecoveringCapture,
      utteranceActive: !!activeUtterance,
      lastRecoveryAt: lastCaptureRecoveryAt,
      silentStartupMs: 45000,
      silentAfterAudioMs: 60000,
      recoveryCooldownMs: 30000,
    })) {
      void recoverCapture('system audio stayed silent', true);
    }
  } catch (error) {
    console.warn('Capture health check failed:', error);
  } finally {
    captureHealthCheckPending = false;
  }
}

function scheduleDeviceChangeRecovery() {
  if (!isContinuousMode || !isListening || isRecoveringCapture) return;
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

/**
 * Electron's modern getDisplayMedia path. This is the preferred Windows
 * loopback method and keeps working with wired/Bluetooth headphones because
 * it captures the system mix, not the room microphone.
 */
async function acquireSystemAudioViaDisplayMedia() {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    },
  });
  displayStream.getVideoTracks().forEach((track) => { track.enabled = false; });
  const audioTrack = displayStream.getAudioTracks()[0];
  if (!audioTrack || audioTrack.readyState !== 'live') {
    displayStream.getTracks().forEach((track) => track.stop());
    throw new Error('Windows did not provide a live system-audio loopback track');
  }
  return displayStream;
}

/**
 * Legacy Chromium desktop-audio path. Some Electron/Windows combinations
 * return an empty audio track from getDisplayMedia even though desktop
 * loopback works through getUserMedia mandatory constraints.
 */
async function acquireSystemAudioViaLegacyBridge() {
  if (!window.api || typeof window.api.getDesktopSources !== 'function') {
    throw new Error('Desktop source bridge is unavailable');
  }
  const sources = await window.api.getDesktopSources();
  const source = (sources || []).find((item) => String(item.id).startsWith('screen:')) || (sources || [])[0];
  if (!source) throw new Error('No screen source available for system audio capture');

  const videoConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: source.id,
      maxWidth: 2,
      maxHeight: 2,
      maxFrameRate: 1,
    },
  };
  const attempts = [
    {
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
        },
      },
      video: videoConstraints,
    },
    {
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: videoConstraints,
    },
  ];

  let lastError = null;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getVideoTracks().forEach((track) => { track.enabled = false; });
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('Legacy loopback track is not live');
      }
      return stream;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Legacy system audio capture failed');
}

async function acquireMicrophoneFallback() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') {
    stream.getTracks().forEach((streamTrack) => streamTrack.stop());
    throw new Error('No live microphone track is available');
  }
  return stream;
}

async function ensureCaptureStream({ allowMicFallback = true } = {}) {
  if (captureStream && captureStream.getAudioTracks().some((track) => track.readyState === 'live')) return captureStream;
  releaseCaptureStream();
  usingMicFallback = false;
  let lastError = null;

  // 1. Preferred: Windows system-audio loopback (works with headphones).
  for (let attempt = 0; attempt < 2 && !captureStream; attempt++) {
    try {
      captureStream = await acquireSystemAudioViaDisplayMedia();
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  // 2. Legacy desktop-audio bridge.
  if (!captureStream) {
    try {
      captureStream = await acquireSystemAudioViaLegacyBridge();
      console.info('Using legacy desktop loopback bridge for interview audio');
    } catch (error) {
      lastError = error;
    }
  }

  // 3. Last resort: microphone. Only useful when the interviewer is audible
  //    through speakers, and only allowed after an explicit user action.
  if (!captureStream && allowMicFallback) {
    console.warn('System audio capture failed, trying microphone fallback:', lastError);
    try {
      captureStream = await acquireMicrophoneFallback();
      usingMicFallback = true;
    } catch (error) {
      lastError = error;
    }
  }

  if (!captureStream) {
    throw lastError || new Error('No live audio capture track is available');
  }

  const track = captureStream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') {
    releaseCaptureStream();
    throw new Error('No live audio capture track is available');
  }

  const streamGeneration = captureGeneration;
  track.addEventListener('ended', () => {
    if (!isListening || streamGeneration !== captureGeneration || track !== captureStream?.getAudioTracks()[0]) return;
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
  const allowMicFallback = isAutoRestart || hasUserStartedCapture || navigator.userActivation?.hasBeenActive === true;

  try {
    const stream = await ensureCaptureStream({ allowMicFallback });
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
    hasUserStartedCapture = true;
    clearUtteranceState();
    isListening = true;
    btnListen.classList.add('active');
    listenLabel.textContent = 'Listening...';
    audioMeter.style.display = 'flex';
    meterMic.style.width = '0%';
    startCaptureHealthMonitor();
    setStatus('listening', usingMicFallback
      ? 'Microphone fallback - headphones will not work'
      : 'Listening to interviewer voice...');
  } catch (error) {
    console.error('Audio capture setup error:', error);
    cleanupAudioGraph();
    releaseCaptureStream();
    const permissionBlocked = error?.name === 'NotAllowedError' || /permission|gesture|denied/i.test(error?.message || '');
    if (permissionBlocked && !hasUserStartedCapture) {
      isContinuousMode = false;
      stopListeningUI();
      setStatus('ready', 'Click "Start Listening" to allow system-audio capture');
    } else if (isAutoRestart && isContinuousMode && captureRecoveryFailures < 3) {
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
  clearUtteranceState();
  stopListeningUI();
  setStatus('ready', 'Ready');
}

function stopListeningUI() {
  isListening = false;
  btnListen.classList.remove('active');
  listenLabel.textContent = 'Start Listening';
  audioMeter.style.display = 'none';
}

async function processQuestion(question, live = false, utteranceId = 0) {
  let text = stripDiscoursePrefix(stripNoiseTags(question));
  if (!text || !isActionableQuestion(text)) return false;

  // While a verified answer is being generated, never let a *different*
  // utterance's live partial (which may be noise) cancel it. A refresh of the
  // same utterance is allowed because the interviewer kept talking.
  if (live && isAnswerBusy && utteranceId !== activeAnswerUtteranceId) return false;

  if (utteranceId > 0) {
    if (utteranceId < latestAnsweredUtteranceId) return false;
    // Only a verified final transcription may claim the "latest question"
    // slot. A noisy live preview must never be able to cancel the correct
    // question that is still being finalized.
    if (!live) latestAnsweredUtteranceId = Math.max(latestAnsweredUtteranceId, utteranceId);
  }

  // Show only the actual question (without the interviewer's lead-in), but
  // send the full transcript to the model so it keeps the context.
  const displayQuestion = extractQuestionCore(text) || text;
  const normalized = normalizeTranscript(displayQuestion);
  const now = Date.now();
  // Skip a duplicate final even if a split produced a new utterance id, so
  // one real question can never generate two answers in a row.
  if (!live && normalized === lastAnsweredQuestion && now - lastAnsweredAt < 8000) {
    showQuestion(displayQuestion);
    return false;
  }
  // A noise fragment that is only a shorter piece of the question already on
  // screen must not replace the answer.
  if (!live && hasVisibleAnswer() && utteranceId > latestAnsweredUtteranceId
    && isFragmentOfShownQuestion(displayQuestion)) {
    return false;
  }
  lastAnsweredQuestion = normalized;
  lastAnsweredAt = now;

  const requestId = ++answerRequestSerial;
  activeAnswerSerial = requestId;
  activeAnswerUtteranceId = utteranceId;
  isAnswerBusy = true;
  let renderedNewAnswer = false;
  let requestText = '';
  // If an answer is already visible it belongs to the previous question. It
  // stays untouched (no spinner, no blank) until this answer is clearly real.
  const replacingVisibleAnswer = hasVisibleAnswer();
  console.log(`Processing ${live ? 'live' : 'final'} question: "${text}"`);
  showQuestion(displayQuestion + (live ? '...' : ''));
  prepareAnswerForRequest();
  setStatus('thinking', live ? 'Answering while interviewer speaks...' : 'Generating answer...');
  listenLabel.textContent = 'Thinking...';

  try {
    const result = await window.api.generateAnswer(text, (chunk) => {
      if (requestId !== activeAnswerSerial || !chunk) return;
      requestText += chunk;

      if (!renderedNewAnswer) {
        // A real answer starts with a full sentence. A cough that produced a
        // two-word "answer" can no longer replace the answer on screen.
        const trimmed = requestText.trim();
        if (replacingVisibleAnswer && trimmed.length < 40 && !/[.!?]/.test(trimmed)) return;

        answerTxt.textContent = '';
        answerTxt.style.display = 'block';
        answerPH.style.display = 'none';
        loader.style.display = 'none';
        isStreamingAnswer = true;
        renderedNewAnswer = true;
        pendingAnswerChunks += requestText;
      } else {
        pendingAnswerChunks += chunk;
      }
      scheduleAnswerFlush();
    });

    if (requestId !== activeAnswerSerial) return false;
    flushAnswerChunks();
    if (result.success) {
      if (renderedNewAnswer && answerTxt.textContent.length > 0) {
        loader.style.display = 'none';
        answerPH.style.display = 'none';
        answerTxt.style.display = 'block';
        isStreamingAnswer = false;
      } else if (!replacingVisibleAnswer || looksLikeRealAnswer(result.answer)) {
        showAnswer(result.answer);
      } else {
        // Junk/truncated answer while a good answer is on screen: keep it.
        console.info('Ignored too-short answer and kept the previous one.');
        setStatus('ready', 'Previous answer kept - audio unclear');
        return false;
      }
      if (renderedNewAnswer || (result.answer && result.answer.trim())) {
        lastSuccessfulQuestion = normalized;
        rememberGoodAnswer(displayQuestion);
      }
      setStatus('ready', 'Answer ready - still listening');
      if (!isListening) listenLabel.textContent = 'Start Listening';
    } else if (!renderedNewAnswer && restoreLastGoodAnswer()) {
      // The request failed before any real text arrived (often a noise-triggered
      // request being rate-limited). Keep the previous answer visible.
      setStatus('ready', 'Previous answer kept - audio unclear');
      console.info('Answer request failed, restored previous answer:', result.error || 'unknown');
    } else if (renderedNewAnswer) {
      setStatus('ready', 'Partial answer kept - still listening');
    } else {
      showError(result.error || 'Answer generation failed');
    }
  } catch (error) {
    if (requestId !== activeAnswerSerial) return false;
    if (!renderedNewAnswer && restoreLastGoodAnswer()) {
      setStatus('ready', 'Previous answer kept - audio unclear');
      console.info('Answer request errored, restored previous answer:', error.message);
    } else if (!renderedNewAnswer) {
      showError('Failed to generate answer: ' + error.message);
    }
  } finally {
    if (requestId === activeAnswerSerial) isAnswerBusy = false;
  }
  return true;
}

btnListen.addEventListener('click', () => {
  if (isContinuousMode || isListening || isStarting) {
    stopListening(true);
  } else {
    hasUserStartedCapture = false;
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

setStatus('ready', 'Click "Start Listening" to capture interviewer voice');

window.addEventListener('DOMContentLoaded', () => {
  // Best-effort auto start. In some Electron versions getDisplayMedia needs a
  // real user gesture; if so we show the click prompt instead of silently
  // falling back to the microphone (which cannot hear headphones at all).
  setTimeout(() => {
    if (!isListening && !isStarting && !isContinuousMode) void startListening();
  }, 400);
});
