const fetch = require('node-fetch');
const line = require('@line/bot-sdk');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ok' });
  }

  const events = req.body && req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).json({ status: 'ok' });
  }

  const event = events[0];
  if (event.type !== 'message' || !event.message || !event.message.text) {
    return res.status(200).json({ status: 'ok' });
  }

  const userMsg = event.message.text.trim();
  const replyToken = event.replyToken;

  try {
    // 補充模式：. 開頭（強制補充上一筆的店名/評價/備註）
    if (userMsg.startsWith('.')) {
      const content = userMsg.slice(1).trim();
      const parts = content.split(/[,，\s]+/);
      const storeName = parts[0] || '';
      const rating = parts[1] || '';
      const note = parts.slice(2).join(' ') || '';
      await updateLastRow({ storeName, rating, note, sheetName: '流水帳' });
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '補上了！🏪 ' + (storeName || '—') + ' ⭐ ' + (rating || '—') + (note ? ' 📌 ' + note : ''),
      });
      return res.status(200).json({ status: 'ok' });
    }

    // 上班開銷：# 開頭
    if (userMsg.startsWith('#')) {
      const content = userMsg.slice(1).trim();
      const numMatch = content.match(/\d+/);
      const amount = numMatch ? Number(numMatch[0]) : 0;
      const item = content.replace(/\d+/g, '').trim();
      await writeToSheet({ item, amount, category: '上班開銷', storeName: '', note: '', sheetName: '上班開銷' });
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '💼 上班開銷記好了！\n📝 ' + item + '\n💰 NT$' + amount,
      });
      return res.status(200).json({ status: 'ok' });
    }

    // 查詢支出
    if (userMsg.includes('今天花') || userMsg.includes('本月花') || userMsg.includes('這個月花') || userMsg.includes('花了多少')) {
      const spendingInfo = await querySpending(userMsg);
      await client.replyMessage(replyToken, { type: 'text', text: spendingInfo });
      return res.status(200).json({ status: 'ok' });
    }

    // 呼叫 Gemini
    const apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;

    const prompt = `你是王老闆的記帳小幫手，女生助理，回覆簡短直接，不過度熱情。

判斷這句話是「記帳」還是「聊天」：

如果是記帳（含金額或消費行為），回傳JSON：
{"type":"accounting","品項":"消費的東西（例如火鍋、計程車、衣服）","金額":數字,"類別":"從以下選一個：食品/交通/娛樂/公司相關/美容/購物","店名":"店名或空字串","備註":"評價或感想或空字串","reply":"一句簡短記帳確認"}

如果是聊天、問候、抱怨或任何非記帳的話，回傳JSON：
{"type":"chat","reply":"簡短回覆，繁體中文，偶爾可加emoji"}

注意：
- 品項只寫消費品項，不含店名和金額
- 店名單獨放在店名欄位
- 評價感想放備註
- 只回傳JSON，不要其他文字

這句話：${userMsg}`;

    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });

    const geminiData = await geminiRes.json();
    console.log('Gemini回傳：', JSON.stringify(geminiData));

    let parsed;
    try {
      const rawText =
        geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      console.log('rawText：', rawText);
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.log('解析失敗：', e.message);
      parsed = { type: 'chat', reply: '再說一次？沒聽清楚 🙏' };
    }

    if (parsed.type === 'accounting') {
      const item = parsed['品項'] || userMsg;
      const amount = Number(parsed['金額']) || 0;
      const category = parsed['類別'] || '食品';
      const storeName = parsed['店名'] || '';
      const note = parsed['備註'] || '';

      await writeToSheet({ item, amount, category, storeName, note, sheetName: '流水帳' });

      let replyText = (parsed.reply || '記好了！') + '\n📝 ' + item + '\n💰 NT$' + amount + '\n🏷️ ' + category;
      if (storeName) replyText += '\n🏪 ' + storeName;
      if (note) replyText += '\n📌 ' + note;

      await client.replyMessage(replyToken, { type: 'text', text: replyText });
    } else {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: parsed.reply || '嗯',
      });
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('錯誤：', err);
    try {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '出錯了，再說一次？',
      });
    } catch (_) {}
    return res.status(200).json({ status: 'error' });
  }
};

async function getDoc() {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  return doc;
}

async function writeToSheet(data) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[data.sheetName];
  const today = new Date().toLocaleDateString('zh-TW');
  await sheet.addRow({
    日期: today,
    品項: data.item,
    金額: data.amount,
    類別: data.category,
    店名: data.storeName || '',
    評價: '',
    備註: data.note || '',
  });
}

async function updateLastRow(data) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[data.sheetName];
  const rows = await sheet.getRows();
  const lastRow = rows[rows.length - 1];
  if (lastRow) {
    if (data.storeName) lastRow['店名'] = data.storeName;
    if (data.rating) lastRow['評價'] = data.rating;
    if (data.note) lastRow['備註'] = data.note;
    await lastRow.save();
  }
}

async function querySpending(msg) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['流水帳'];
  const rows = await sheet.getRows();
  const now = new Date();
  const todayStr = now.toLocaleDateString('zh-TW');
  const thisMonth = now.getFullYear() + '/' + (now.getMonth() + 1);

  const isToday = msg.includes('今天');
  let total = 0;
  let count = 0;

  for (const row of rows) {
    const date = row['日期'] || '';
    const amount = Number(row['金額']) || 0;
    if (isToday && date === todayStr) {
      total += amount;
      count++;
    } else if (!isToday && date.startsWith(thisMonth)) {
      total += amount;
      count++;
    }
  }

  const period = isToday ? '今天' : '本月';
  let result = '📊 ' + period + '共花了 NT$' + total + '，共 ' + count + ' 筆';
  if (total > 3000) result += '\n花挺多的。';
  return result;
}
