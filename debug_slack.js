import { sendSlackMarkdown } from './src/services/slack.js';

async function test() {
  try {
    console.log('Sending to Daily channel...');
    await sendSlackMarkdown('Test Daily', 'Test Daily Content', 'test-uid', 'test@gmail.com', 'daily');
    
    console.log('Sending to Weekly channel...');
    await sendSlackMarkdown('Test Weekly', 'Test Weekly Content', 'test-uid', 'test@gmail.com', 'weekly');
    
    console.log('Sending to Urgent channel...');
    await sendSlackMarkdown('Test Urgent', 'Test Urgent Content', 'test-uid', 'test@gmail.com', 'urgent');
  } catch (err) {
    console.error('Caught error:', err);
  }
}

test();
