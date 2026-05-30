import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL ? process.env.SLACK_WEBHOOK_URL.trim() : null;

/**
 * Sends a raw text message to Slack.
 * @param {string} text - Message text
 */
export async function sendSlackMessage(text) {
  if (!slackWebhookUrl || slackWebhookUrl === 'your_slack_webhook_url_here') {
    console.log('[Slack Notifier] Webhook URL not configured. Skipped sending message.');
    return false;
  }

  try {
    await axios.post(slackWebhookUrl, {
      text: text
    });
    console.log('[Slack Notifier] Message successfully sent to Slack.');
    return true;
  } catch (err) {
    console.error('[Slack Notifier] Failed to send message to Slack:', err.message);
    return false;
  }
}

/**
 * Helper to parse markdown tables and convert them to Slack-friendly list format.
 */
function convertMarkdownTables(markdown) {
  let lines = markdown.split('\n');
  let inTable = false;
  let tableLines = [];
  let resultLines = [];

  const parseRow = (row) => row.split('|').map(cell => cell.trim()).filter((cell, index, arr) => index > 0 && index < arr.length - 1);

  const convertTable = (tLines) => {
    if (tLines.length < 3) return tLines.join('\n'); // Too short to be a valid table
    
    const headers = parseRow(tLines[0]);
    let output = '';
    
    for (let i = 2; i < tLines.length; i++) {
      const cells = parseRow(tLines[i]);
      if (cells.length === 0) continue;
      
      // Table 1: 종목별 주간 이벤트 누적 추이
      if (headers.includes('종목명') && headers.includes('최종 권고 기조')) {
        const name = cells[0].replace(/\*\*/g, ''); 
        const ticker = cells[1] ? cells[1].replace(/`/g, '') : '';
        const totalEv = cells[2] || '0';
        const buy = cells[3] || '0';
        const sellReduce = cells[4] || '0';
        const holdWatch = cells[5] || '0';
        const action = cells[6] ? cells[6].replace(/\*\*/g, '') : '보유 유지';
        
        output += `• *${name}* (${ticker}): 이벤트 ${totalEv}개 (추매 ${buy}, 매도/축소 ${sellReduce}, 보유/관찰 ${holdWatch}) ➔ *${action}*\n`;
      } 
      // Table 2: AI 자동 복구 내역
      else if (headers.includes('이전 주소') && headers.includes('AI 복구된 새 주소')) {
        const name = cells[0].replace(/\*\*/g, '');
        const type = cells[1] || '';
        const oldUrl = cells[2] ? cells[2].replace(/`/g, '') : '';
        const newUrl = cells[3] || '';
        const reason = cells[4] || '';
        
        let cleanNewUrl = newUrl;
        const linkMatch = newUrl.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
          cleanNewUrl = linkMatch[2];
        }
        
        output += `• *${name}* [${type}]:\n  - 이전 주소: \`${oldUrl}\`\n  - 복구 주소: <${cleanNewUrl}|이동>\n  - 복구 사유: ${reason}\n`;
      }
      // Table 3: 즉시 분석 대응 가이드 (구체적 거래 추천 수량 테이블)
      else if (headers.includes('구체적 거래 추천 수량') || headers.includes('추천 의사결정')) {
        const name = cells[0].replace(/\*\*/g, '');
        const ticker = cells[1] ? cells[1].replace(/`/g, '') : '';
        const price = cells[2] || '';
        const change = cells[3] || '';
        const qty = cells[4] || '';
        const weight = cells[5] || '';
        const signal = cells[6] ? cells[6].replace(/\*\*/g, '') : '';
        const recommendation = cells[7] ? cells[7].replace(/\*\*/g, '') : '';

        output += `• *${name}* (\`${ticker}\`): 현재가 ${price} (${change}) | 보유: ${qty} (비중 ${weight})\n  └ *추천 기조:* ${signal}\n  └ *추천 거래 수량:* ${recommendation}\n`;
      }
      // Generic Table fallback
      else {
        let rowStr = '• ';
        for (let j = 0; j < cells.length; j++) {
          const header = headers[j] || `Col${j+1}`;
          const cellVal = cells[j] || '';
          rowStr += `*${header}*: ${cellVal} | `;
        }
        if (rowStr.endsWith(' | ')) {
          rowStr = rowStr.substring(0, rowStr.length - 3);
        }
        output += rowStr + '\n';
      }
    }
    return output;
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      inTable = true;
      tableLines.push(lines[i]);
    } else {
      if (inTable) {
        let converted = convertTable(tableLines);
        resultLines.push(converted);
        tableLines = [];
        inTable = false;
      }
      resultLines.push(lines[i]);
    }
  }
  
  if (inTable && tableLines.length > 0) {
    let converted = convertTable(tableLines);
    resultLines.push(converted);
  }

  return resultLines.join('\n');
}

/**
 * Converts standard Markdown to Slack's mrkdwn format and sends it.
 * Slack supports bullet points, bold (*), italics (_), strikethrough (~), code blocks (```).
 * It does NOT support headers (#), standard links [text](url) (Slack uses <url|text>).
 * @param {string} title - The title of the alert
 * @param {string} markdown - The markdown content
 */
export async function sendSlackMarkdown(title, markdown) {
  if (!slackWebhookUrl || slackWebhookUrl === 'your_slack_webhook_url_here') {
    console.log('[Slack Notifier] Webhook URL not configured. Skipped sending report.');
    return false;
  }

  // Pre-process markdown to convert tables to Slack-friendly lists
  const processedMarkdown = convertMarkdownTables(markdown);

  try {
    let slackText = `*${title}*\n\n`;

    // Simple markdown-to-slack converters
    let lines = processedMarkdown.split('\n');
    for (let line of lines) {
      // Convert headers: # Header -> *Header*
      if (line.startsWith('#')) {
        const cleanHeader = line.replace(/^#+\s+/, '');
        slackText += `*${cleanHeader}*\n`;
        continue;
      }
      
      // Convert links: [text](url) -> <url|text>
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      line = line.replace(linkRegex, '<$2|$1>');

      // Convert bold: **text** -> *text*
      line = line.replace(/\*\*([^*]+)\*\*/g, '*$1*');

      // Convert inline code: `code` -> `code` (kept same)
      
      slackText += line + '\n';
    }

    // Split text into chunks if it exceeds Slack's 4000 char limit
    const chunks = [];
    const maxLimit = 3500;
    
    if (slackText.length > maxLimit) {
      let currentChunk = '';
      const paragraphs = slackText.split('\n');
      for (const p of paragraphs) {
        if ((currentChunk + p).length > maxLimit) {
          chunks.push(currentChunk);
          currentChunk = p + '\n';
        } else {
          currentChunk += p + '\n';
        }
      }
      if (currentChunk.trim() !== '') {
        chunks.push(currentChunk);
      }
    } else {
      chunks.push(slackText);
    }

    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        text: chunks[i],
        unfurl_links: false,
        unfurl_media: false
      };
      await axios.post(slackWebhookUrl, payload);
    }

    console.log('[Slack Notifier] Markdown report successfully sent to Slack in ' + chunks.length + ' chunks.');
    return true;
  } catch (err) {
    console.error('[Slack Notifier] Failed to send markdown report to Slack:', err.message);
    return false;
  }
}
