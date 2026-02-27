/**
 * imessage-sender.ts
 * Sends iMessages/SMS via AppleScript — the janky glue between Solana and your group chat
 *
 * IMPORTANT: Messages app must be running and configured for SMS forwarding
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Escape a string for use inside AppleScript string literals
 * AppleScript uses double quotes, so we need to escape them.
 * We also need to escape backslashes.
 */
function escapeForAppleScript(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * Send an SMS/iMessage to a phone number via AppleScript
 * Tries SMS service first, falls back to iMessage
 */
export async function sendMessage(phoneNumber: string, message: string): Promise<void> {
  const escapedMessage = escapeForAppleScript(message);
  const escapedPhone = escapeForAppleScript(phoneNumber);

  // Try SMS first (works even if recipient isn't on iMessage)
  const smsScript = `tell application "Messages"
    set targetService to 1st service whose service type = SMS
    set targetBuddy to buddy "${escapedPhone}" of targetService
    send "${escapedMessage}" to targetBuddy
  end tell`;

  try {
    await execAsync(`osascript -e '${smsScript.replace(/'/g, "'\"'\"'")}'`);
    console.log(`📤 Sent SMS to ${phoneNumber}: ${message.slice(0, 50)}...`);
    return;
  } catch (smsErr: any) {
    console.log(`SMS send failed, trying iMessage: ${smsErr.message}`);
  }

  // Fallback: try iMessage
  const imessageScript = `tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${escapedPhone}" of targetService
    send "${escapedMessage}" to targetBuddy
  end tell`;

  try {
    await execAsync(`osascript -e '${imessageScript.replace(/'/g, "'\"'\"'")}'`);
    console.log(`📤 Sent iMessage to ${phoneNumber}: ${message.slice(0, 50)}...`);
  } catch (imsgErr: any) {
    console.error(`❌ Failed to send message to ${phoneNumber}:`, imsgErr.message);
    throw imsgErr;
  }
}

/**
 * Send a reply to a fan — includes QUORUM branding
 * For when the bot needs to be charismatic
 */
export async function sendQuorumReply(phoneNumber: string, message: string): Promise<void> {
  return sendMessage(phoneNumber, message);
}

// Quick test
if (require.main === module) {
  const testNumber = process.argv[2];
  const testMessage = process.argv[3] || 'QUORUM test message 🎫';

  if (!testNumber) {
    console.log('Usage: ts-node bot/imessage-sender.ts <phone_number> [message]');
    process.exit(1);
  }

  sendMessage(testNumber, testMessage)
    .then(() => console.log('✅ Message sent'))
    .catch(err => console.error('❌ Failed:', err.message));
}
