const line = require('@line/bot-sdk');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ok' });
  }

  const events = req.body?.events;
  if (!events || events.length === 0) {
    return res.status(200).json({ status: 'ok' });
  }

  const event = events[0];
  if (event.type !== 'message' || !event.message?.text) {
    return res.status(200).json({ status: 'ok' });
  }

  const userMsg = event.message.text.trim();
  const replyToken = event.replyToken;

  try {
    // 補充模式：. 開頭
    if (userMsg.startsWith('.')) {
      const content = userMsg.slice(1).trim();
      const parts = content.split(/[,，\s]+/);
      const storeName = parts[0] || '';
      const rating = parts[1] || '';
      const note = parts.slice(2).join(' ') || '';

      await updateLastRow({ storeName, rating, note });

      await client.replyMessage(replyToken, {
        type: 'text',
        text: `✅ 已補充！\n🏪 ${storeName || '—'}\n⭐ ${rating || '—'}\n📌 ${note || '—'}`
      });
      return res.status(200).json({ status: 'ok' });
    }

    // 一般記帳，呼叫 Gemini
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `請從以下句子中找出消費品項和金額。
規則：
1. 只回傳JSON，不要任何其他文字
2. 金額必須是純數字（例如1580），不是字串
3. 如果找不到金額就填0
4. 品項只留商品或活動名稱，完全不能包含任何數字或金額，例如「水果冰120」要變成「水果冰」
5. 類別從以下選一個：食品、交通、娛樂、公司相關

回傳格式：{"品項":"xxx","金額":數字,"類別":"xxx"}

句子：${userMsg}`
            }]
          }]
        })
      }
    );

    const geminiData = await geminiRes.json();

    let parsed;
    try {
      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { 品項: userMsg, 金額: 0, 類別: '食品' };
    }

    const 品項 = (parsed['品項'] || userMsg).replace(/\d+/g, '').trim();
    const numMatch = userMsg.match(/\d+/);
    const 金額 = numMatch ? Number(numMatch[0]) : (Number(parsed['金額']) || 0);
    const 類別 = detectCategory(userMsg) || parsed['類別'] || '食品';

    await writeToSheet({ 品項, 金額, 類別 });

    await client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 已記帳！\n📝 ${品項}\n💰 NT$${金額}\n🏷️ ${類別}\n\n想補充店名/評價/備註嗎？\n格式：. 店名 評價 備註`
    });

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error(err);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '記帳失敗，請重試'
    });
    return res.status(200).json({ status: 'error' });
  }
};

function detectCategory(text) {
  const rules = [
    { keywords: ['飯','麵','便當','火鍋','飲料','咖啡','茶','水果','零食','餅','冰','湯','肉','蛋','菜','早餐','午餐','晚餐','宵夜','吃','喝','食','滷'], category: '食品' },
    { keywords: ['捷運','車錢','計程車','uber','油','停車','高鐵','台鐵','火車','機票','交通','票','白牌'], category: '交通' },
    { keywords: ['電影','ktv','遊戲','旅遊','景點','門票','唱歌','玩','娛樂','酒','夜市'], category: '娛樂' },
    { keywords: ['pla','耗材','線材','樹脂','拓竹','bambu','filament','材料','印表機','3d','工具','機器','設備','零件'], category: '公司相關' },
  ];
  const lower = text.toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.some(k => lower.includes(k.toLowerCase()))) {
      return rule.category;
    }
  }
  return '食品';
}

async function writeToSheet(data) {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['流水帳'];
  const today = new Date().toLocaleDateString('zh-TW');
  await sheet.addRow({
    日期: today,
    品項: data.品項,
    金額: data.金額,
    類別: data.類別,
    店名: '',
    評價: '',
    備註: '',
  });
}

async function updateLastRow({ storeName, rating, note }) {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['流水帳'];
  const rows = await sheet.getRows();
  const lastRow = rows[rows.length - 1];
  if (lastRow) {
    if (storeName) lastRow['店名'] = storeName;
    if (rating) lastRow['評價'] = rating;
    if (note) lastRow['備註'] = note;
    await lastRow.save();
  }
}
