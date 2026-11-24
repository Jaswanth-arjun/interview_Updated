(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InterviewAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeTranscript(text) {
    return String(text || '').toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g)?.join(' ') || '';
  }

  function isVoiceLikeAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate) {
    if (!Number.isFinite(rmsDb) || rmsDb < -68) return false;
    if (Number.isFinite(zeroCrossingRate) && zeroCrossingRate > 0.35) return false;
    if (!Number.isFinite(voiceEnergy) || !Number.isFinite(highEnergy)) return true;
    if (highEnergy < 3) return voiceEnergy >= 1.5;
    return voiceEnergy >= highEnergy * 0.9;
  }

  function isConfidentVoiceAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate) {
    if (!isVoiceLikeAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate)) return false;
    if (Number.isFinite(zeroCrossingRate) && zeroCrossingRate > 0.25) return false;
    if (!Number.isFinite(voiceEnergy) || !Number.isFinite(highEnergy)) return true;
    if (highEnergy < 3) return voiceEnergy >= 2;
    return voiceEnergy >= highEnergy * 1.4;
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
    const value = String(text || '').trim();
    if (value.length < 8) return false;
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;
    if (/^(\[|\().*(\]|\))$/i.test(value)) return false;
    const foreign = (value.match(/[^a-zA-Z0-9 .,?!'"-:;()&/$%@#+\n]/g) || []).length;
    if (foreign / value.length > 0.04) return false;
    if (/^(thank(s| you)?|thanks (for )?watching|okay+|ok|yeah|yes|no|hello+|hi+|bye+|tchau|obrigado|gracias|merci|arigato|danke|sorry|wow|umm*|hmm*|bye bye|see you|goodbye|ding|chime|beep|bell)\b/i.test(value)) return false;
    return true;
  }

  function isActionableQuestion(text) {
    const value = String(text || '').trim();
    if (!isLikelyQuestion(value)) return false;
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length >= 3 && value.includes('?')) return true;
    if (words.length >= 3 && /^(what|why|how|when|where|which|who)\b/i.test(value)) return true;
    if (words.length >= 4 && /^(can|could|would|will|do|does|did|is|are|was|were|have|has)\b/i.test(value)) return true;
    if (words.length >= 3 && /^(tell me|walk me through|describe|explain|give me|share)\b/i.test(value)) return true;
    return words.length >= 6;
  }

  function shouldStartLiveAnswer(text, stablePreviewCount) {
    if (!isActionableQuestion(text)) return false;
    const value = String(text).trim();
    const wordCount = value.split(/\s+/).filter(Boolean).length;
    return wordCount >= 6 || value.includes('?') || stablePreviewCount >= 2;
  }

  function mergeLiveTranscript(previous, next) {
    const previousValue = String(previous || '').trim();
    const nextValue = String(next || '').trim();
    if (!nextValue) return previousValue;
    if (!previousValue) return nextValue;
    const previousWords = normalizeTranscript(previousValue).split(' ').filter(Boolean);
    const nextWords = normalizeTranscript(nextValue).split(' ').filter(Boolean);
    if (nextWords.length > previousWords.length) return nextValue;
    if (nextWords.length === previousWords.length) return nextValue;
    return previousValue;
  }

  function questionsMatch(early, final) {
    const earlyText = normalizeTranscript(early);
    const finalText = normalizeTranscript(final);
    if (!earlyText || !finalText) return false;
    if (earlyText === finalText) return true;
    if (finalText.startsWith(earlyText + ' ') || finalText === earlyText) return true;
    const earlyWords = earlyText.split(' ');
    const finalWords = finalText.split(' ');
    if (earlyWords.length - finalWords.length <= 2 && earlyText.startsWith(finalText + ' ')) return true;
    let shared = 0;
    while (shared < earlyWords.length && shared < finalWords.length && earlyWords[shared] === finalWords[shared]) shared++;
    return shared >= 3 && shared / Math.min(earlyWords.length, finalWords.length) >= 0.7;
  }

  class AdaptiveSpeechDetector {
    constructor(options = {}) {
      this.minSpeechMs = options.minSpeechMs || 110;
      this.silenceMs = options.silenceMs || 340;
      this.maxUtteranceMs = options.maxUtteranceMs || 18000;
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

      if (this.calibrationRemainingMs > 0) {
        this.calibrationRemainingMs -= duration;
        if (!voiceLike) {
          this.noiseFloorDb = this.noiseFloorDb * 0.8 + Math.max(-75, Math.min(-62, rmsDb)) * 0.2;
        }
        return null;
      }

      if (!this.active) {
        if (!voiceLike && rmsDb < -58) this.noiseFloorDb = this.noiseFloorDb * 0.94 + Math.max(-75, rmsDb) * 0.06;
        const thresholdDb = Math.max(-66, this.noiseFloorDb + 7);
        const voiced = rmsDb >= thresholdDb && isVoiceLikeAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate);
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
      const thresholdDb = Math.max(-64, this.noiseFloorDb + 7);
      const voiced = rmsDb >= thresholdDb && isVoiceLikeAudio(rmsDb, voiceEnergy, highEnergy, zeroCrossingRate);
      if (voiced) {
        this.silenceDurationMs = 0;
        if (this.utteranceMs >= this.maxUtteranceMs) return 'limit';
      } else {
        this.silenceDurationMs += duration;
        if (this.silenceDurationMs >= this.silenceMs) {
          this.active = false;
          this.noiseFloorDb = this.noiseFloorDb * 0.8 + Math.max(-75, Math.min(-20, rmsDb)) * 0.2;
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
  }) {
    if (recovering) return false;
    if (trackEnded || trackMuted) return true;
    if (utteranceActive || now - startedAt < 1500 || now - lastRecoveryAt < 15000) return false;
    return heardAudio ? now - lastAudibleAt >= 20000 : now - startedAt >= 15000;
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

  return {
    AdaptiveSpeechDetector,
    downsampleBuffer,
    encodeWAV,
    isActionableQuestion,
    isConfidentVoiceAudio,
    isLikelyQuestion,
    isVoiceLikeAudio,
    mergeLiveTranscript,
    normalizeTranscript,
    questionsMatch,
    shouldFinalizeTrailingNoise,
    shouldRecoverCapture,
    shouldStartLiveAnswer,
  };
});
