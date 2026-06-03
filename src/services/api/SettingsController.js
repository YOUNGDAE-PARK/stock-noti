import { NotificationService } from '../notificationService.js';

export class SettingsController {
  static async getSettings(req, res) {
    try {
      const settings = await NotificationService.getUserConfig(req.user);
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  static async updateSettings(req, res) {
    try {
      await NotificationService.updateUserConfig(req.user, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  static async testSlack(req, res) {
    try {
      const success = await NotificationService.sendSimpleAlert(
        req.user,
        '🔔 [Stock-Noti] Slack 연동 및 알림 테스트 수신 성공!'
      );
      if (success) res.json({ success: true });
      else res.status(500).json({ error: 'Slack delivery failed.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
}
