(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InterviewAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Interviewers naturally start questions with discourse markers such as
  // "Okay, so...", "Right...", "Thank you. Now..." or "No, what I mean is...".
  // These are NOT part of the question, and must never cause a real question
  // to be discarded.
  const DISCOURSE_PREFIX = /^(?:(?:okay|ok|alright|all\s+right|right|so|well|now|um+|uh+|er+|ah+|eh+|yeah|yep|yes|no|nope|oh|hmm+|mm+|and|but)\b[\s,.;:!?\-–—]*)+/i;
  const COURTESY_PREFIX = /^(?:(?:thank\s+you(?:\s+(?:very\s+much|so\s+much|for\s+(?:that|your\s+time|watching)))?|thanks(?:\s+(?:a\s+lot|so\s+much|for\s+(?:that|your\s+time|watching)))?|great|good|nice|perfect|cool|awesome|excellent|sure|of\s+course)\b[\s,.;:!?\-–—]*)+/i;
  const PREAMBLE_PREFIX = /^(?:(?:the\s+question\s+is|my\s+question\s+is|what\s+i\s+(?:just\s+)?(?:wanted|want)\s+to\s+(?:ask|know)\s+is)[\s,.;:!?\-–—]*)+/i;
  const MEETING_CHATTER = /^(?:(?:hi|hello|hey|yeah|yes|no|okay|ok|so|right)[\s,.!?]*)?(?:how\s+are\s+you(?:\s+doing)?|how(?:'s|\s+is)\s+it\s+going|what(?:'s|\s+is)\s+up|you\s+there|are\s+you\s+there|are\s+you\s+with\s+me|(?:can|could)\s+you\s+hear\s+me(?:\s+(?:now|clearly|okay|alright))?|(?:do|did)\s+you\s+hear\s+me|am\s+i\s+audible|are\s+you\s+able\s+to\s+hear\s+me|(?:can|could)\s+you\s+see\s+my\s+screen|is\s+my\s+screen\s+(?:visible|clear|showing)|are\s+you\s+(?:ready|comfortable)|is\s+(?:that|this|it)\s+(?:okay|ok|clear|fine|working)|does\s+that\s+make\s+sense|make\s+sense|(?:can|could|shall|should)\s+we\s+(?:start|begin|proceed|continue)|let(?:'s|\s+us)\s+(?:start|begin))[\s.!?]*$/i;

  // Whisper writes background noise as tags like [BLANK_AUDIO], (upbeat music),
  // [Music] etc. They must never be shown as an interview question.
  const NOISE_TAG = /\[(?:blank_?audio|silence|music|applause|laughter|noise|inaudible|footsteps)[^\]]*\]|\((?:blank_?audio|silence|music|applause|laughter|noise|inaudible|upbeat[^)]*|dramatic[^)]*|soft[^)]*music[^)]*|background[^)]*)\)/gi;

  function normalizeTranscript(text) {
    return String(text || '').toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g)?.join(' ') || '';
  }

  function stripNoiseTags(text) {
    return String(text || '').replace(NOISE_TAG, ' ').replace(/\s+/g, ' ').trim();
  }

  function stripDiscoursePrefix(text) {
    let value = stripNoiseTags(text);
    for (let i = 0; i < 4; i++) {
      const next = value
        .replace(COURTESY_PREFIX, '')
        .replace(DISCOURSE_PREFIX, '')
        .replace(PREAMBLE_PREFIX, '')
        .replace(/^[\s,.;:!?\-–—]+/, '')
        .trim();
      if (next === value) break;
      value = next;
    }
    return value;
  }

  function isVoiceLikeAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate) {
    if (!Number.isFinite(rmsDb) || rmsDb < -75) return false;
    if (Number.isFinite(zeroCrossingRate) && zeroCrossingRate > 0.35) return false;
    if (!Number.isFinite(voiceEnergy) || !Number.isFinite(highEnergy)) return true;
    if (highEnergy < 3) return voiceEnergy >= 1.5;
    return voiceEnergy >= highEnergy * 0.9;
  }

  function isConfidentVoiceAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate) {
    if (!isVoiceLikeAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate)) return false;
    if (Number.isFinite(zeroCrossingRate) && zeroCrossingRate > 0.25) return false;
    if (!Number.isFinite(voiceEnergy) || !Number.isFinite(highEnergy)) return true;
    if (highEnergy < 3) return voiceEnergy >= 4;
    return voiceEnergy >= highEnergy * 1.4;
  }

  function hasEnoughSpeechEvidence({
    voicedMs = 0,
    confidentVoicedMs = 0,
    modulatedVoicedMs = 0,
    live = false,
  }) {
    if (!Number.isFinite(voicedMs) || !Number.isFinite(confidentVoicedMs) || !Number.isFinite(modulatedVoicedMs)) {
      return false;
    }
    // Live previews must start while the interviewer is still speaking, so
    // they only need a short, clearly voice-shaped burst of audio.
    if (confidentVoicedMs >= (live ? 220 : 350)) return true;
    // Quiet earbud speech may never clear the absolute spectral-confidence
    // threshold, but natural syllable dynamics distinguish it from steady hum.
    const modulatedFallbackMs = live ? 280 : 550;
    if (modulatedVoicedMs >= modulatedFallbackMs && voicedMs >= modulatedFallbackMs) return true;
    return voicedMs >= 1200 && confidentVoicedMs >= 200;
  }

  function shouldFinalizeTrailingNoise({
    now,
    lastConfidentVoiceAt,
    utteranceActive,
    utteranceFinalizing,
    durationMs,
    minDurationMs = 550,
    trailingNoiseMs = 1500,
  }) {
    return utteranceActive && !utteranceFinalizing && durationMs >= minDurationMs && now - lastConfidentVoiceAt >= trailingNoiseMs;
  }

  function isLikelyQuestion(text) {
    const original = String(text || '').trim();
    if (!original) return false;
    const value = stripDiscoursePrefix(original);
    if (!value) return false;

    const words = value.split(/\s+/).filter(Boolean);
    if (!words.length) return false;

    // A bare "Why?" / "How?" is still a valid interview follow-up.
    if (words.length === 1) {
      const bareWord = words[0].replace(/[^a-z]/gi, '');
      return /\?$/.test(value) && /^(what|why|how|when|where|which|who|whom|whose)$/i.test(bareWord);
    }

    if (value.length < 6) return false;
    if (/^[\[(].*[\])]$/.test(value) && !value.includes('?')) return false;

    // Reject foreign-language hallucinations, emoji, etc. but allow normal
    // punctuation including smart quotes and dashes.
    const foreign = (value.match(/[^a-zA-Z0-9 .,?!'"“”‘’\-–—:;()&/$%@#+\n]/g) || []).length;
    if (foreign / value.length > 0.06) return false;

    const unique = new Set(words.map((word) => word.toLowerCase().replace(/[^a-z0-9']/g, '')).filter(Boolean));
    if (words.length >= 6 && unique.size <= 2) return false;

    if (/^(?:thank(s| you)?|bye+|goodbye|see you|hello+|hi+)\b/i.test(value) && words.length <= 3) return false;

    return true;
  }

  // Real interviewers rarely speak in perfect question sentences: they lead
  // with context ("On your resume it says you used React...") and only then
  // ask. The actionable part is therefore the trailing question clause, not
  // necessarily the first word of the transcript.
  const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;
  const INLINE_REQUEST = /\b(?:(?:can|could|would|will)\s+(?:you|your|we)\b|(?:tell|walk|show|describe|explain|share|give)\s+(?:me|us)\b)/i;
  const WH_START = /^(what|why|how|when|where|which|who|whom|whose|what's|how's|why's)\b/i;
  const AUX_START = /^(can|could|would|will|do|does|did|is|are|was|were|have|has|should|shall|may|might|any)\b/i;
  const EMBEDDED_QUESTION = /\b(?:can|could|would|will|should|do|does|did|are|is|was|were|have|has)\s+(?:you|your|we)\b/i;
  const STARTS_IMPERATIVE = /^(tell|walk|describe|explain|introduce|elaborate|clarify|provide|give|share|talk|outline|summari[sz]e|discuss|suppose|imagine|consider|help\s+me\s+understand|let'?s)\b/i;
  const REQUEST_IMPERATIVE = /\b(?:i'?d|we'?d|i\s+would|we\s+would)\s+like\s+(?:you|us)\s+to\b|\bhelp\s+me\s+understand\b|\b(?:i\s+was\s+wonder(?:ing)?|i'?m\s+curious|i'?d\s+like\s+to\s+know|i\s+(?:just\s+)?(?:wanted|want)\s+to\s+(?:ask|know)|we'?d\s+like\s+to\s+know)\b/i;
  // "I just wanted to ask you a question" is a setup sentence, not the actual
  // question. Never answer it early or display it as the question.
  const SETUP_SENTENCE = /^(?:i\s+)?(?:just\s+)?(?:wanted|want|would\s+like)\s+to\s+ask(?:\s+you)?(?:\s+a\s+(?:quick\s+)?question)?[.!]*$/i;

  function isQuestionCore(rawCore) {
    const core = stripDiscoursePrefix(rawCore);
    if (!core) return false;
    const words = core.split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;
    if (MEETING_CHATTER.test(core.trim())) return false;
    if (SETUP_SENTENCE.test(core)) return false;

    const lower = core.toLowerCase();

    // A spoken question mark is strong evidence. Require at least three words
    // so a stray "?" from background noise cannot become a question.
    if (core.includes('?') && words.length >= 3) return true;

    if (WH_START.test(lower) && words.length >= 3) return true;
    if (AUX_START.test(lower) && words.length >= 4) return true;
    if (EMBEDDED_QUESTION.test(lower) && words.length >= 4) return true;
    if (STARTS_IMPERATIVE.test(lower) && words.length >= 2) return true;
    if (/^please\b/i.test(lower) && words.length >= 2) return true;
    if (REQUEST_IMPERATIVE.test(lower) && words.length >= 4) return true;

    return false;
  }

  // Returns only the part of the transcript that is the actual question, so
  // the overlay shows the question instead of the interviewer's lead-in.
  // Empty string means nothing answerable was found.
  function extractQuestionCore(text) {
    const value = stripDiscoursePrefix(text);
    if (!value) return '';

    // Prefer the trailing sentence: interviewers usually lead with context
    // and ask the real question last.
    const sentences = value.split(SENTENCE_BOUNDARY).map((sentence) => sentence.trim()).filter(Boolean);
    if (sentences.length > 1) {
      for (let i = sentences.length - 1; i >= 0; i--) {
        const candidate = stripDiscoursePrefix(sentences[i]);
        if (isQuestionCore(candidate)) return candidate;
      }
    }

    if (isQuestionCore(value)) return value;

    // Whisper often drops the punctuation of a spoken lead-in. Fall back to
    // the request clause embedded in the middle of an unpunctuated sentence.
    const inline = INLINE_REQUEST.exec(value);
    if (inline && inline.index > 0) {
      const candidate = stripDiscoursePrefix(value.slice(inline.index));
      if (candidate.split(/\s+/).filter(Boolean).length >= 3 && isQuestionCore(candidate)) return candidate;
    }
    return '';
  }

  // Display text for a partial transcript while the interviewer is still
  // talking. Returns the question core as soon as it exists, otherwise the
  // cleaned partial itself so the user sees the question forming instead of a
  // stale placeholder. Empty string means nothing worth showing yet.
  function extractLiveQuestionPreview(text) {
    const value = stripDiscoursePrefix(text);
    if (!value) return '';
    const core = extractQuestionCore(value);
    if (core) return core;
    if (!isLikelyQuestion(value)) return '';
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length < 4) return '';
    return value;
  }

  // Decides whether a transcript is an actual interview prompt that deserves
  // an answer. Random statements/lyrics from background audio must be
  // rejected, while all common interviewer phrasings (questions, imperatives,
  // "tell me...", "walk me through...", trailing questions after context)
  // pass.
  function isActionableQuestion(text) {
    const value = stripDiscoursePrefix(text);
    if (!isLikelyQuestion(value)) return false;

    const words = value.split(/\s+/).filter(Boolean);
    if (!words.length) return false;

    if (MEETING_CHATTER.test(value.trim())) return false;

    if (words.length === 1) {
      return /\?$/.test(value) && /^(what|why|how|when|where|which|who|whom|whose)$/i.test(words[0].replace(/[^a-z]/gi, ''));
    }
    if (SETUP_SENTENCE.test(value)) return false;

    return extractQuestionCore(value) !== '';
  }

  function shouldStartLiveAnswer(text, stablePreviewCount, allowFirstPreview = false) {
    if (!isActionableQuestion(text)) return false;
    const value = extractQuestionCore(text) || stripDiscoursePrefix(text);
    const words = value.split(/\s+/).filter(Boolean);
    if (!words.length) return false;

    if (value.includes('?')) return stablePreviewCount >= 1 || (allowFirstPreview && words.length >= 5);

    // Never start an answer while the partial transcript still ends in the
    // middle of a phrase ("...tell me about the", "...and how do you").
    const dangling = /(?:^|\s)(?:and|or|but|so|that|the|a|an|to|of|with|for|about|in|on|at|by|from|as|is|are|was|were|do|does|did|can|could|would|will|should|how|what|why|when|where|which|who|your|my|our|their|you|we|they|it|between|versus|vs|compared|including|within|without|using|through|across|during|while|if|because|since|than|then|also|just|really|very)\s*$/i;
    if (dangling.test(value)) return false;

    if (stablePreviewCount >= 1 && words.length >= 5) return true;

    const strongCue =
      /^(tell\s+(?:me|us)|walk\s+(?:me|us)\s+through|describe|explain|give\s+(?:me|us)|share|talk\s+about|let'?s\s+(?:talk|start|begin|discuss))/i.test(value) ||
      /\b(can|could|would|will)\s+you\s+(?:tell|walk|describe|explain|share|talk|give)\b/i.test(value);
    const whCue = /^(what|why|how|when|where|which|who)\b/i.test(value);

    // Start answering on the very first confident partial when it already
    // reads like a question. Waiting for a second decode is what made the
    // answer arrive after the interviewer had finished talking.
    if (allowFirstPreview && (strongCue || whCue) && words.length >= 5) return true;

    return strongCue && words.length >= 4;
  }

  function commonPrefixWords(a, b) {
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
    return shared;
  }

  function jaccardSimilarity(a, b) {
    if (!a.length || !b.length) return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const word of setA) if (setB.has(word)) intersection++;
    return intersection / (setA.size + setB.size - intersection);
  }

  function mergeLiveTranscript(previous, next) {
    const previousValue = String(previous || '').trim();
    const nextValue = String(next || '').trim();
    if (!nextValue) return previousValue;
    if (!previousValue) return nextValue;

    const previousWords = normalizeTranscript(previousValue).split(' ').filter(Boolean);
    const nextWords = normalizeTranscript(nextValue).split(' ').filter(Boolean);
    if (!previousWords.length) return nextValue;
    if (!nextWords.length) return previousValue;

    if (nextWords.join(' ') === previousWords.join(' ')) return nextValue;
    if (nextWords.join(' ').startsWith(previousWords.join(' ') + ' ')) return nextValue;
    if (previousWords.join(' ').startsWith(nextWords.join(' ') + ' ')) return previousValue;

    const shared = commonPrefixWords(previousWords, nextWords);
    const similarity = jaccardSimilarity(previousWords, nextWords);
    if (shared >= Math.min(3, Math.min(previousWords.length, nextWords.length)) || similarity >= 0.6) {
      return nextWords.length >= previousWords.length ? nextValue : previousValue;
    }

    // Completely different decode: the newest one is usually the better
    // decode of the same audio, so use it instead of getting stuck on a
    // bad earlier hallucination.
    return nextValue;
  }

  function questionsMatch(early, final) {
    const earlyText = normalizeTranscript(early);
    const finalText = normalizeTranscript(final);
    if (!earlyText || !finalText) return false;
    if (earlyText === finalText) return true;

    const earlyWords = earlyText.split(' ');
    const finalWords = finalText.split(' ');
    if (finalText.startsWith(earlyText + ' ') || earlyText.startsWith(finalText + ' ')) return true;

    const earlySet = new Set(earlyWords);
    const finalSet = new Set(finalWords);
    const smaller = earlyWords.length <= finalWords.length ? earlySet : finalSet;
    const larger = earlyWords.length <= finalWords.length ? finalSet : earlySet;
    let contained = 0;
    for (const word of smaller) if (larger.has(word)) contained++;

    if (contained / smaller.size >= 0.9 && Math.abs(earlyWords.length - finalWords.length) <= 2) return true;
    if (jaccardSimilarity(earlyWords, finalWords) >= 0.8) return true;
    return false;
  }

  class AdaptiveSpeechDetector {
    constructor(options = {}) {
      this.minSpeechMs = options.minSpeechMs || 90;
      // 340 ms keeps the unit-test/API default snappy. The overlay passes a
      // longer value (~800 ms) so natural mid-sentence pauses do not split a
      // single question into two misleading fragments.
      this.silenceMs = options.silenceMs || 340;
      this.maxUtteranceMs = options.maxUtteranceMs || 20000;
      this.calibrationMs = options.calibrationMs || 250;
      this.reset();
    }

    reset(preserveCalibration = false) {
      this.active = false;
      this.noiseFloorDb = preserveCalibration ? this.noiseFloorDb : -70;
      this.speechMs = 0;
      this.silenceDurationMs = 0;
      this.utteranceMs = 0;
      this.calibrationRemainingMs = preserveCalibration ? 0 : this.calibrationMs;
    }

    update(rmsDb, voiceEnergy, highEnergy, durationMs, zeroCrossingRate) {
      if (!Number.isFinite(rmsDb) || !Number.isFinite(durationMs)) return null;
      const duration = Math.max(0, durationMs);
      const voiceLike = isVoiceLikeAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate);
      const confidentVoice = isConfidentVoiceAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate);

      if (this.calibrationRemainingMs > 0) {
        this.calibrationRemainingMs -= duration;
        if (!voiceLike) {
          this.noiseFloorDb = this.noiseFloorDb * 0.8 + Math.max(-75, Math.min(-62, rmsDb)) * 0.2;
        }
        if (!confidentVoice) return null;
      }

      const floor = Math.max(-75, Math.min(-40, this.noiseFloorDb));

      if (!this.active) {
        if (!voiceLike && rmsDb < -50) this.noiseFloorDb = floor * 0.94 + Math.max(-75, Math.min(-40, rmsDb)) * 0.06;
        const thresholdDb = Math.max(-72, floor + 6);
        const voiced = rmsDb >= thresholdDb && voiceLike;
        this.speechMs = voiced ? this.speechMs + duration : Math.max(0, this.speechMs - duration * 1.5);
        if (this.speechMs >= this.minSpeechMs) {
          this.active = true;
          this.silenceDurationMs = 0;
          this.utteranceMs = 0;
          return 'start';
        }
        return null;
      }

      this.utteranceMs += duration;
      // While already in a question, use a slightly more sensitive threshold
      // so quiet syllables (and headphone/earbud audio) are not cut off.
      const activeFloor = Math.max(-75, Math.min(-40, this.noiseFloorDb));
      const thresholdDb = Math.max(-74, activeFloor + 3);
      const voiced = rmsDb >= thresholdDb && voiceLike;

      if (voiced) {
        this.silenceDurationMs = 0;
        if (this.utteranceMs >= this.maxUtteranceMs) {
          this.active = false;
          this.speechMs = 0;
          this.silenceDurationMs = 0;
          this.utteranceMs = 0;
          return 'limit';
        }
      } else {
        this.silenceDurationMs += duration;
        if (this.silenceDurationMs >= this.silenceMs) {
          this.active = false;
          this.speechMs = 0;
          this.utteranceMs = 0;
          this.noiseFloorDb = this.noiseFloorDb * 0.8 + Math.max(-75, Math.min(-30, rmsDb)) * 0.2;
          return 'end';
        }
      }
      return null;
    }
  }

  function shouldRecoverCapture({
    now,
    startedAt,
    lastAudibleAt,
    heardAudio,
    recovering = false,
    utteranceActive = false,
    lastRecoveryAt = 0,
    trackEnded = false,
    trackMuted = false,
    silentStartupMs = 15000,
    silentAfterAudioMs = 20000,
    recoveryCooldownMs = 15000,
  }) {
    if (recovering) return false;
    if (trackEnded || trackMuted) return true;
    if (utteranceActive || now - startedAt < 1500 || now - lastRecoveryAt < recoveryCooldownMs) return false;
    return heardAudio ? now - lastAudibleAt >= silentAfterAudioMs : now - startedAt >= silentStartupMs;
  }

  function downsampleBuffer(buffer, sampleRate, outSampleRate = 16000) {
    if (outSampleRate === sampleRate) return buffer;
    const ratio = sampleRate / outSampleRate;
    const result = new Float32Array(Math.round(buffer.length / ratio));
    let outputIndex = 0;
    let inputIndex = 0;
    while (outputIndex < result.length) {
      const nextInputIndex = Math.round((outputIndex + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let i = inputIndex; i < nextInputIndex && i < buffer.length; i++) {
        sum += buffer[i];
        count++;
      }
      result[outputIndex] = count ? sum / count : 0;
      outputIndex++;
      inputIndex = nextInputIndex;
    }
    return result;
  }

  function encodeWAV(samples, sampleRate = 16000) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buffer;
  }

  // Remove leading/trailing silence before sending audio to Whisper. Sending
  // mostly-silent audio is the #1 cause of hallucinated "questions".
  function trimSilence(samples, sampleRate = 16000, options = {}) {
    if (!samples || !samples.length) return samples;
    const threshold = options.threshold || 0.004;
    const leadPadMs = options.leadPadMs ?? 100;
    const tailPadMs = options.tailPadMs ?? 160;

    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    if (peak <= 1e-5) return new Float32Array(0);

    const adaptiveThreshold = Math.max(threshold, peak * 0.045);
    let first = 0;
    while (first < samples.length && Math.abs(samples[first]) < adaptiveThreshold) first++;
    let last = samples.length - 1;
    while (last > first && Math.abs(samples[last]) < adaptiveThreshold) last--;
    if (first > last) return new Float32Array(0);

    const leadPad = Math.round((leadPadMs * sampleRate) / 1000);
    const tailPad = Math.round((tailPadMs * sampleRate) / 1000);
    return samples.subarray(Math.max(0, first - leadPad), Math.min(samples.length, last + tailPad + 1));
  }

  // Quiet earphone/loopback audio is often 10-20 dB below normal. A gentle
  // peak normalisation makes Whisper much more accurate without amplifying
  // the noise floor excessively.
  function normalizeAudio(samples, options = {}) {
    if (!samples || !samples.length) return samples;
    const targetPeak = options.targetPeak ?? 0.7;
    const maxGain = options.maxGain ?? 3;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    if (peak <= 1e-5) return samples;
    const gain = Math.min(maxGain, targetPeak / peak);
    if (gain <= 1.05) return samples;
    const result = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      result[i] = Math.max(-1, Math.min(1, samples[i] * gain));
    }
    return result;
  }

  function prepareAudioForTranscription(samples, sampleRate = 16000) {
    if (!samples || !samples.length) return samples;
    const trimmed = trimSilence(samples, sampleRate);
    if (!trimmed.length) return trimmed;
    return normalizeAudio(trimmed);
  }

  return {
    AdaptiveSpeechDetector,
    downsampleBuffer,
    encodeWAV,
    extractLiveQuestionPreview,
    extractQuestionCore,
    isActionableQuestion,
    isConfidentVoiceAudio,
    isLikelyQuestion,
    hasEnoughSpeechEvidence,
    isVoiceLikeAudio,
    mergeLiveTranscript,
    normalizeAudio,
    normalizeTranscript,
    prepareAudioForTranscription,
    questionsMatch,
    shouldFinalizeTrailingNoise,
    shouldRecoverCapture,
    shouldStartLiveAnswer,
    stripDiscoursePrefix,
    stripNoiseTags,
    trimSilence,
  };
});
