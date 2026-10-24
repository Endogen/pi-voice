import { waitForConnection } from './connection.mjs';

// Only the short connection task returns a result. The long-lived host task is
// separate, so the native Activity does not wait for Pi itself to exit. Stdout
// contains a credential: return through an explicit PendingIntent, never log it.
try {
  const { url } = await waitForConnection();
  process.stdout.write(`${JSON.stringify({ url })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
}
