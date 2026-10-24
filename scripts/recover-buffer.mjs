import { PollingQueueClient } from '@vercel/queue';
import { consumeRequest, REGION, TOPIC } from '../server/durable-intake.js';
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw Error('Postgres must be connected before recovery');
const oldDeployment = process.argv[2];
// These are the two 8a99f14 production builds made during the documented
// uninterrupted Firestore quota outage. Their chat jobs could not commit.
const allowed = new Set(['dpl_AgWikhaPcRfyQrLmUUP2JHK6wFvW', 'dpl_8xmmwVpJmqvLdYKiAzcTTo33nwpT']);
if (!allowed.has(oldDeployment)) throw Error('Unreviewed recovery deployment');
const queue = new PollingQueueClient({ region: REGION, deploymentId: oldDeployment });
let processed = 0;
for (let batch = 0; batch < 50; batch++) {
  const result = await queue.receive(TOPIC, 'postgres-recovery', async payload => {
    await consumeRequest(payload); processed++;
  }, { limit: 10, visibilityTimeoutSeconds: 120 });
  if (!result.ok) {
    console.log(JSON.stringify({ check: 'previous_buffer_recovery', deployment: oldDeployment, processed, reason: result.reason }));
    break;
  }
  if (batch === 49) console.log(JSON.stringify({ check: 'previous_buffer_recovery', deployment: oldDeployment, processed, truncated: true }));
}
