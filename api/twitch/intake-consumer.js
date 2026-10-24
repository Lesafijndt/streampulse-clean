import { QueueClient } from '@vercel/queue';
import { consumeRequest, retryDelay, REGION } from '../../server/durable-intake.js';
const queue = new QueueClient({ region: REGION });
export default queue.handleNodeCallback(consumeRequest, {
  visibilityTimeoutSeconds: 120, retry: retryDelay,
});
