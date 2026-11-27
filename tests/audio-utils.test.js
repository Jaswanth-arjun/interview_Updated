const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AdaptiveSpeechDetector,
  downsampleBuffer,
  encodeWAV,
  extractQuestionCore,
  isActionableQuestion,
  isConfidentVoiceAudio,
  isLikelyQuestion,
  isVoiceLikeAudio,
  hasEnoughSpeechEvidence,
  mergeLiveTranscript,
  prepareAudioForTranscription,
  questionsMatch,
  shouldFinalizeTrailingNoise,
  shouldRecoverCapture,
  shouldStartLiveAnswer,
  extractLiveQuestionPreview,
  stripDiscoursePrefix,
  trimSilence,
} = require('../src/overlay/audio-utils');

function calibrate(detector, db = -70) {
  for (let i = 0; i < 6; i++) detector.update(db, 1, 1, 50);
}

test('detects quiet earphone speech with adaptive thresholds', () => {
  const detector = new AdaptiveSpeechDetector();
  calibrate(detector);
  const events = [];
  for (let i = 0; i < 4; i++) events.push(detector.update(-54, 9, 2, 50));
  assert.ok(events.includes('start'));

  const endEvents = [];
  for (let i = 0; i < 8; i++) endEvents.push(detector.update(-75, 0, 0, 50));
  assert.ok(endEvents.includes('end'));
});

test('does not learn immediate quiet speech as background noise', () => {
  const detector = new AdaptiveSpeechDetector();
  calibrate(detector, -54);
  const events = [];
  for (let i = 0; i < 4; i++) events.push(detector.update(-54, 9, 2, 50));
  assert.ok(events.includes('start'));
});

test('detects very quiet earphone speech immediately after startup', () => {
  const detector = new AdaptiveSpeechDetector();
  const events = [];
  for (let i = 0; i < 8; i++) events.push(detector.update(-62, 9, 2, 50));
  assert.ok(events.includes('start'));
});

test('starts confident speech during startup calibration without learning it as noise', () => {
  const detector = new AdaptiveSpeechDetector();
  const events = [];
  for (let i = 0; i < 2; i++) events.push(detector.update(-54, 9, 2, 50, 0.08));
  assert.ok(events.includes('start'));
  assert.equal(detector.noiseFloorDb, -70);
});

test('rejects a loud high-frequency notification', () => {
  const detector = new AdaptiveSpeechDetector();
  calibrate(detector);
  for (let i = 0; i < 12; i++) assert.equal(detector.update(-18, 2, 90, 50), null);
  assert.equal(detector.active, false);
});

test('rejects steady broadband noise instead of treating it as interviewer speech', () => {
  const detector = new AdaptiveSpeechDetector();
  calibrate(detector);
  for (let i = 0; i < 12; i++) assert.equal(detector.update(-52, 1.2, 1, 50, 0.48), null);
  assert.equal(detector.active, false);
  assert.equal(isVoiceLikeAudio(-52, 1.2, 1, 0.48), false);
  assert.equal(isVoiceLikeAudio(-54, 9, 2, 0.08), true);
  assert.equal(isConfidentVoiceAudio(-54, 9, 2, 0.08), true);
  assert.equal(isConfidentVoiceAudio(-52, 1.6, 1, 0.1), false);
  assert.equal(isConfidentVoiceAudio(-26, 2, 1, 0.02), false);
});

test('requires sustained voice-band evidence before transcribing noise', () => {
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 2000, confidentVoicedMs: 0 }), false);
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 900, confidentVoicedMs: 250 }), false);
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 1200, confidentVoicedMs: 200 }), true);
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 400, confidentVoicedMs: 350 }), true);
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 400, confidentVoicedMs: 300, live: true }), true);
});

test('accepts quiet speech evidence from natural voice modulation', () => {
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 700, confidentVoicedMs: 0, modulatedVoicedMs: 500, live: true }), true);
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 700, confidentVoicedMs: 0, modulatedVoicedMs: 500 }), false);
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 2000, confidentVoicedMs: 0, modulatedVoicedMs: 0 }), false);
});

test('ends an utterance when interviewer speech turns into trailing broadband noise', () => {
  const detector = new AdaptiveSpeechDetector();
  calibrate(detector);
  const events = [];
  for (let i = 0; i < 4; i++) events.push(detector.update(-54, 9, 2, 50, 0.08));
  for (let i = 0; i < 8; i++) events.push(detector.update(-52, 1.2, 1, 50, 0.48));
  assert.ok(events.includes('start'));
  assert.ok(events.includes('end'));
});

test('preserves the calibrated noise floor between consecutive questions', () => {
  const detector = new AdaptiveSpeechDetector();
  calibrate(detector);
  const noiseFloor = detector.noiseFloorDb;
  detector.reset(true);
  assert.equal(detector.calibrationRemainingMs, 0);
  assert.equal(detector.noiseFloorDb, noiseFloor);
  const events = [];
  for (let i = 0; i < 4; i++) events.push(detector.update(-54, 9, 2, 50, 0.08));
  assert.ok(events.includes('start'));
});

test('finalizes a long enough utterance after sustained trailing noise', () => {
  const state = {
    now: 5000,
    lastConfidentVoiceAt: 3500,
    utteranceActive: true,
    utteranceFinalizing: false,
    durationMs: 2400,
  };
  assert.equal(shouldFinalizeTrailingNoise(state), true);
  assert.equal(shouldFinalizeTrailingNoise({ ...state, now: 4999 }), false);
  assert.equal(shouldFinalizeTrailingNoise({ ...state, durationMs: 400 }), false);
});

test('recognizes actionable questions without accepting sentence fragments', () => {
  assert.equal(isActionableQuestion('What is React?'), true);
  assert.equal(isActionableQuestion('Tell me about yourself'), true);
  assert.equal(isActionableQuestion('Can you explain your experience with distributed systems?'), true);
  assert.equal(isActionableQuestion('Can you explain'), false);
  assert.equal(isActionableQuestion('thank you very much'), false);
  assert.equal(isLikelyQuestion('[notification sound]'), false);
});

test('accepts real questions that begin with natural interviewer filler', () => {
  assert.equal(isActionableQuestion('Okay, so can you tell me about yourself?'), true);
  assert.equal(isActionableQuestion('Thank you. Now, can you explain your project?'), true);
  assert.equal(isActionableQuestion('No, what I mean is how do you handle conflict?'), true);
  assert.equal(isActionableQuestion('Right, walk me through your resume.'), true);
  assert.equal(isActionableQuestion('Why?'), true);
  assert.equal(stripDiscoursePrefix('Okay, so what is React?'), 'what is React?');
});

test('detects the question that follows an interviewer lead-in', () => {
  assert.equal(isActionableQuestion('So on your resume it says you worked on React for two years. Tell me about that project.'), true);
  assert.equal(isActionableQuestion('so you worked on react for two years tell me about that project'), true);
  assert.equal(isActionableQuestion('I see you used Java before. How did you handle the migration?'), true);
  assert.equal(isActionableQuestion('You mentioned leading a team earlier. What was the hardest part?'), true);
  assert.equal(isActionableQuestion('The weather is nice today and I had lunch.'), false);
  assert.equal(extractQuestionCore('I see you used Java before. How did you handle the migration?'), 'How did you handle the migration?');
  assert.equal(extractQuestionCore('so you worked on react for two years tell me about that project'), 'tell me about that project');
  assert.equal(extractQuestionCore('The weather is nice today.'), '');
});

test('rejects statements and background chatter that are not questions', () => {
  assert.equal(isActionableQuestion('I have five years of experience.'), false);
  assert.equal(isActionableQuestion('The weather is nice today.'), false);
  assert.equal(isActionableQuestion('(upbeat music playing)'), false);
  assert.equal(isLikelyQuestion('[BLANK_AUDIO]'), false);
  assert.equal(isActionableQuestion('Can you hear me now?'), false);
  assert.equal(isActionableQuestion('Can you see my screen?'), false);
  assert.equal(isActionableQuestion('How are you doing?'), false);
  assert.equal(isActionableQuestion('Shall we start?'), false);
  assert.equal(isActionableQuestion('What is your current role?'), true);
});

test('does not treat a corrected question as the same question', () => {
  assert.equal(questionsMatch('what is your experience with java', 'what is your experience with react'), false);
  assert.equal(questionsMatch('can you tell me about yourself', 'can you tell me about your projects'), false);
  assert.equal(questionsMatch('tell me about yourself', 'tell me about yourself and your projects'), true);
});

test('keeps natural pauses inside one question by using a longer silence window', () => {
  const detector = new AdaptiveSpeechDetector({ silenceMs: 800 });
  calibrate(detector);
  const events = [];
  for (let i = 0; i < 4; i++) events.push(detector.update(-54, 9, 2, 50, 0.08));
  for (let i = 0; i < 10; i++) events.push(detector.update(-75, 0, 0, 50, 0.08));
  assert.ok(events.includes('start'));
  assert.equal(events.includes('end'), false);
  for (let i = 0; i < 7; i++) events.push(detector.update(-75, 0, 0, 50, 0.08));
  assert.ok(events.includes('end'));
});

test('trims leading and trailing silence before transcription', () => {
  const samples = new Float32Array(16000);
  for (let i = 5000; i < 10000; i++) samples[i] = 0.25;
  const trimmed = trimSilence(samples, 16000);
  assert.ok(trimmed.length > 5000);
  assert.ok(trimmed.length < samples.length);
  const prepared = prepareAudioForTranscription(samples, 16000);
  let peak = 0;
  for (const value of prepared) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak >= 0.5);
});

test('starts live answers early only when the partial question is useful', () => {
  assert.equal(shouldStartLiveAnswer('What is React?', 1), true);
  assert.equal(shouldStartLiveAnswer('Tell me about', 2), false);
  assert.equal(shouldStartLiveAnswer('Tell me about yourself', 1), true);
  assert.equal(shouldStartLiveAnswer('Tell me about yourself', 2), true);
  assert.equal(shouldStartLiveAnswer('Can you walk me through your approach to debugging production issues', 1), true);
  assert.equal(shouldStartLiveAnswer('What is your experience with Java?', 0), false);
  assert.equal(shouldStartLiveAnswer('What is your experience with Java?', 0, true), true);
  assert.equal(shouldStartLiveAnswer('What did you do?', 0, true), false);
});

test('shows the question as soon as the interviewer starts speaking', () => {
  assert.equal(extractLiveQuestionPreview('Okay so what is the difference'), 'what is the difference');
  assert.equal(extractLiveQuestionPreview('on your resume it says you worked on react'), 'on your resume it says you worked on react');
  assert.equal(extractLiveQuestionPreview('and'), '');
  assert.equal(extractLiveQuestionPreview('[BLANK_AUDIO]'), '');
});

test('starts a live answer on the first confident partial', () => {
  assert.equal(shouldStartLiveAnswer('What are the main differences between SQL and NoSQL', 0, true), true);
  assert.equal(shouldStartLiveAnswer('How do you handle database migrations', 0, true), true);
  assert.equal(hasEnoughSpeechEvidence({ voicedMs: 320, confidentVoicedMs: 0, modulatedVoicedMs: 300, live: true }), true);
});

test('keeps longer live transcripts and reconciles final wording', () => {
  assert.equal(mergeLiveTranscript('What is React', 'What is'), 'What is React');
  assert.equal(mergeLiveTranscript('What is React', 'What is React and how does it work?'), 'What is React and how does it work?');
  assert.equal(questionsMatch('What is React?', 'What is React and how does it work?'), true);
  assert.equal(questionsMatch('What is React?', 'How do you handle conflict in a team?'), false);
});

test('encodes standard 16 kHz mono WAV audio', () => {
  const wav = encodeWAV(new Float32Array([0, 0.5, -0.5]), 16000);
  const view = new DataView(wav);
  assert.equal(String.fromCharCode(...new Uint8Array(wav, 0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...new Uint8Array(wav, 8, 4)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(downsampleBuffer(new Float32Array(480), 48000).length, 160);
});

test('reconnects immediately for an ended or muted Bluetooth route', () => {
  const health = { now: 5000, startedAt: 0, lastAudibleAt: 4900, heardAudio: true, utteranceActive: true };
  assert.equal(shouldRecoverCapture({ ...health, trackEnded: true }), true);
  assert.equal(shouldRecoverCapture({ ...health, trackMuted: true }), true);
});

test('does not interrupt speech just because loopback went quiet', () => {
  assert.equal(shouldRecoverCapture({
    now: 30000,
    startedAt: 0,
    lastAudibleAt: 5000,
    heardAudio: true,
    utteranceActive: true,
    lastRecoveryAt: 0,
  }), false);
});

test('reacquires a loopback route that has never carried audio', () => {
  assert.equal(shouldRecoverCapture({
    now: 14999,
    startedAt: 0,
    lastAudibleAt: 0,
    heardAudio: false,
    lastRecoveryAt: 0,
  }), false);
  assert.equal(shouldRecoverCapture({
    now: 15000,
    startedAt: 0,
    lastAudibleAt: 0,
    heardAudio: false,
    lastRecoveryAt: 0,
  }), true);
});

test('reacquires a previously working route after sustained silence', () => {
  assert.equal(shouldRecoverCapture({
    now: 24999,
    startedAt: 0,
    lastAudibleAt: 5000,
    heardAudio: true,
    lastRecoveryAt: 0,
  }), false);
  assert.equal(shouldRecoverCapture({
    now: 25000,
    startedAt: 0,
    lastAudibleAt: 5000,
    heardAudio: true,
    lastRecoveryAt: 0,
  }), true);
});

test('respects the reconnect cooldown and startup grace', () => {
  assert.equal(shouldRecoverCapture({
    now: 30000,
    startedAt: 25000,
    lastAudibleAt: 25000,
    heardAudio: false,
    lastRecoveryAt: 25000,
  }), false);
  assert.equal(shouldRecoverCapture({
    now: 2000,
    startedAt: 1000,
    lastAudibleAt: 1000,
    heardAudio: false,
    lastRecoveryAt: 0,
  }), false);
});
