import { sendSlackMessage, sendSlackMarkdown } from './slack.js';
import { getDb } from '../db/db.js';

/**
 * High-level service to handle user notifications with automatic webhook resolution.
 */
export class NotificationService {
  /**
   * Sends a personalized alert to a user's Slack channel.
   * @param {Object} user - { uid, email }
   * @param {string} title - Alert title
   * @param {string} markdown - Report content
   * @param {string} channelType - 'daily' | 'weekly' | 'urgent'
   */
  static async sendPersonalizedReport(user, title, markdown, channelType = 'daily') {
    console.log(`[NotificationService] Delivering report to user: ${user.email || user.uid} via ${channelType} channel`);
    return await sendSlackMarkdown(title, markdown, user.uid, user.email, channelType);
  }

  /**
   * Sends a simple text message.
   * @param {Object} user - { uid, email }
   * @param {string} text - Message text
   * @param {string} channelType - 'daily' | 'weekly' | 'urgent'
   */
  static async sendSimpleAlert(user, text, channelType = 'daily') {
    return await sendSlackMessage(text, user.uid, user.email, channelType);
  }

  /**
   * Fetches user-specific configuration (e.g., webhook URL).
   */
  static async getUserConfig(user) {
    const db = await getDb(user.uid, user.email);
    const rows = await db.all('SELECT config_key, config_value FROM user_config');
    return rows.reduce((acc, row) => {
      acc[row.config_key] = row.config_value;
      return acc;
    }, {});
  }

  /**
   * Updates user-specific configuration.
   */
  static async updateUserConfig(user, updates) {
    const db = await getDb(user.uid, user.email);
    for (const [key, value] of Object.entries(updates)) {
      await db.run(
        'INSERT OR REPLACE INTO user_config (config_key, config_value) VALUES (?, ?)',
        [key, value]
      );
    }
    return { success: true };
  }
}
