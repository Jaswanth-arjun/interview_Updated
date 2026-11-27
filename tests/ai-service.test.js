const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = 'test-groq-key';

const meterCalls = [];
let meterGate = null;
const meterPath = require.resolve('../server/src/services/meterService');
require.cache[meterPath] = {
  id: meterPath,
  filename: meterPath,
  loaded: true,
  exports: {
    logAndMeterUsage: async (_userId, usage) => {
      meterCalls.push(usage);
      if (meterGate) await meterGate;
    },
  },
};

const loggerPath = require.resolve('../server/src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

const aiService = require('../server/src/services/aiService');
const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
  meterGate = null;
});

test('live transcription returns incomplete text without metering', async () => {
  meterCalls.length = 0;
  global.fetch = async () => Response.json({ text: 'Can you' });
  const result = await aiService.transcribeAudio('demo-user', Buffer.alloc(128).toString('base64'), 'audio/wav', false, true, true);
  assert.equal(result.success, true);
  assert.equal(result.text, 'Can you');
  assert.equal(meterCalls.length, 0);
});

test('final transcription filters noise and meters without delaying the result', async () => {
  meterCalls.length = 0;
  global.fetch = async () => Response.json({ text: 'thank you' });
  const result = await aiService.transcribeAudio('demo-user', Buffer.alloc(128).toString('base64'), 'audio/wav', false, true, false);
  assert.deepEqual(result, { success: true, text: '' });
  assert.equal(meterCalls.length, 1);
  assert.equal(meterCalls[0].requestType, 'transcribe');
});

test('keeps real questions that start with interviewer filler', () => {
  assert.equal(aiService.isLikelyQuestion('Okay, so can you tell me about yourself?'), true);
  assert.equal(aiService.isLikelyQuestion('Thank you. Now, can you explain your project?'), true);
  assert.equal(aiService.isLikelyQuestion('Right, walk me through your resume.'), true);
  assert.equal(aiService.isLikelyQuestion('Why?'), true);
  assert.equal(aiService.isLikelyQuestion('thank you very much'), false);
  assert.equal(aiService.isLikelyQuestion('[BLANK_AUDIO]'), false);
});

test('cleaning preserves the question after courtesy phrases', () => {
  assert.equal(aiService.cleanTranscriptionText('Thank you. Now, can you explain your project?'), 'Thank you. Now, can you explain your project?');
  assert.equal(aiService.cleanTranscriptionText('you'), '');
  assert.equal(aiService.cleanTranscriptionText('(upbeat music)'), '');
});

test('live preview rejects extreme noise metadata without metering', async () => {
  meterCalls.length = 0;
  global.fetch = async () => Response.json({
    text: 'Tell me about yourself',
    segments: [{ text: 'Tell me about yourself', no_speech_prob: 0.97, avg_logprob: -1.4 }],
  });
  const result = await aiService.transcribeAudio('demo-user', Buffer.alloc(128).toString('base64'), 'audio/wav', false, true, true);
  assert.deepEqual(result, { success: true, text: '' });
  assert.equal(meterCalls.length, 0);
});

test('final transcription rejects Whisper high-confidence noise hallucinations', async () => {
  meterCalls.length = 0;
  global.fetch = async () => Response.json({
    text: 'Can you explain your experience?',
    segments: [{ text: 'Can you explain your experience?', no_speech_prob: 0.96, avg_logprob: -1.3 }],
  });
  const result = await aiService.transcribeAudio('demo-user', Buffer.alloc(128).toString('base64'), 'audio/wav', false, true, false);
  assert.deepEqual(result, { success: true, text: '' });
});

test('final transcription accepts confident speech and requests verbose metadata', async () => {
  let responseFormat;
  global.fetch = async (_url, options) => {
    responseFormat = options.body.get('response_format');
    return Response.json({
      text: 'Can you explain your experience?',
      segments: [{ text: 'Can you explain your experience?', no_speech_prob: 0.08, avg_logprob: -0.2 }],
    });
  };
  const result = await aiService.transcribeAudio('demo-user', Buffer.alloc(128).toString('base64'), 'audio/wav', false, true, false);
  assert.equal(result.text, 'Can you explain your experience?');
  assert.equal(responseFormat, 'verbose_json');
});

test('answer streaming completes before slow usage logging', async () => {
  let releaseMeter;
  meterGate = new Promise((resolve) => { releaseMeter = resolve; });
  const writes = [];
  let ended = false;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const body = [
      'data: {"choices":[{"delta":{"content":"React is"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":" a UI library."}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    return new Response(body, { status: 200 });
  };
  const response = {
    setHeader() {},
    flushHeaders() {},
    write(chunk) { writes.push(chunk); },
    end() { ended = true; },
  };

  const profile = {
    roleName: 'Backend Engineer',
    companyName: 'Northstar Labs',
    jobDescription: 'Build reliable payment services.',
    resumeText: 'Built a refund reconciliation service in Java and Spring Boot.',
    projects: 'Refund Reconciler reduced manual review by 30%.',
    extraNotes: 'I led a team of three engineers and mentored two interns.',
  };
  const generation = aiService.generateAnswerStream('demo-user', 'Tell me about your project experience.', profile, response, false, false);
  const outcome = await Promise.race([
    generation.then(() => 'completed'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 500)),
  ]);
  assert.equal(outcome, 'completed');
  assert.equal(ended, true);
  assert.equal(requestBody.reasoning_effort, 'low');
  assert.equal(requestBody.max_tokens, 450);
  assert.match(requestBody.messages[0].content, /first person/);
  assert.match(requestBody.messages[0].content, /70-120 words/);
  assert.match(requestBody.messages[0].content, /simple, everyday words/);
  assert.match(requestBody.messages[0].content, /No markdown/);
  assert.match(requestBody.messages[0].content, /only source of truth/);
  assert.match(requestBody.messages[0].content, /Never invent/);
  assert.ok(requestBody.messages[0].content.includes(profile.resumeText));
  assert.ok(requestBody.messages[0].content.includes(profile.projects));
  assert.ok(requestBody.messages[0].content.includes(profile.extraNotes));
  assert.ok(writes.some((chunk) => chunk.includes('React is')));
  assert.ok(writes.some((chunk) => chunk.includes('"done":true')));
  releaseMeter();
});
