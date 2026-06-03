import fs from 'fs';
import path from 'path';
import { getReportsDir } from '../../utils/paths.js';

export class ReportController {
  static async listReports(req, res) {
    const reportDir = getReportsDir(req.user.uid);
    try {
      if (!fs.existsSync(reportDir)) return res.json([]);
      
      const files = fs.readdirSync(reportDir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const filePath = path.join(reportDir, f);
          const stats = fs.statSync(filePath);
          
          // Infer type from filename
          let type = 'daily';
          if (f.startsWith('hourly_')) type = 'hourly';
          else if (f.startsWith('weekly_')) type = 'backtest';
          else if (f.startsWith('instant_')) type = 'instant';
          else if (f.startsWith('simulation_')) type = 'backtest';

          return {
            filename: f,
            type: type,
            sizeBytes: stats.size,
            date: stats.mtime.toISOString().substring(0, 16).replace('T', ' '),
            created_at: stats.mtime
          };
        })
        .sort((a, b) => b.created_at - a.created_at);
      
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getReport(req, res) {
    const { filename } = req.params;
    const reportDir = getReportsDir(req.user.uid);
    const filePath = path.resolve(path.join(reportDir, filename));
    
    // Security: Check if filePath is within reportDir
    if (!filePath.startsWith(path.resolve(reportDir))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    try {
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Report not found' });
      const content = fs.readFileSync(filePath, 'utf-8');
      
      // Return as JSON object to prevent "Unexpected token #" error in frontend
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
}
