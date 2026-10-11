import assert from 'node:assert/strict';
import { workersAiFailure } from '../worker/semantic-review.mjs';
for (const [error,status,expected,code] of [
  [{code:3036,message:'private detail'},429,'quota_exhausted',3036],
  [new Error('AiError: 3036: You have used up your daily free allocation of 10,000 neurons'),0,'quota_exhausted',3036],
  [new Error('daily neuron quota exceeded'),0,'quota_exhausted',undefined],
  [new Error('Rate limit exceeded'),0,'model_busy',undefined],
  [new Error('3040: Capacity temporarily exceeded, please try again'),0,'model_busy',3040],
  [new Error('input token limit exceeded'),0,'model_input_limit',undefined],
  [{code:3006,message:'private request content'},413,'model_input_limit',3006],
  [new Error('model_timeout'),0,'model_timeout',undefined],
  [new Error('Some other limit exceeded; private prompt'),0,'model_request_failed',undefined],
  [{code:5035,message:'requires paid plan'},403,'model_access_denied',5035],
]) {
 const classified=workersAiFailure(error,status);
 assert.equal(classified.message,expected);assert.equal(classified.provider_code,code);
 assert.ok(!JSON.stringify(classified).includes('private'));
}
console.log('Daily neuron quota, transient rate/capacity, input size, timeout and access errors stay distinct; raw provider messages are not exposed.');
